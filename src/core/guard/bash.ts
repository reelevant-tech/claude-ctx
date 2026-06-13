/**
 * Bash command classifier. Per sub-command, the first matching rule wins
 * (severe > destructive > inefficient). Must never throw: a guard that breaks
 * a coding session is worse than no guard.
 */
import { posix, resolve } from 'node:path'
import picomatch from 'picomatch'
import { isCtxCliMisuse, isMcpShellMisuse, CTX_CLI_GUARD_SUGGESTION, MCP_SHELL_GUARD_SUGGESTION } from '../mcp-rules'
import type { GuardVerdict } from '../types'

export interface BashGuardContext {
  repoRoot: string
  secretGlobs: string[]
  riskyGlobs: string[]
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

interface SubCapture {
  text: string
  inner: string
  next: number
}

// s[start] === '$', s[start+1] === '('. Quote state inside $() is independent.
function captureSubstitution(s: string, start: number): SubCapture {
  let i = start + 2
  let depth = 1
  let inS = false
  let inD = false
  while (i < s.length && depth > 0) {
    const c = s[i]
    if (c === undefined) break
    if (inS) {
      if (c === "'") inS = false
    } else if (inD) {
      if (c === '"') inD = false
      else if (c === '$' && s[i + 1] === '(') {
        depth++
        i++
      }
    } else if (c === "'") inS = true
    else if (c === '"') inD = true
    else if (c === '$' && s[i + 1] === '(') {
      depth++
      i++
    } else if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  const innerEnd = depth === 0 ? i - 1 : i
  return { text: s.slice(start, i), inner: s.slice(start + 2, innerEnd), next: i }
}

function splitInner(command: string, depth: number): string[] {
  const parts: string[] = []
  const subs: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  let i = 0
  const push = (): void => {
    const t = cur.trim()
    if (t) parts.push(t)
    cur = ''
  }
  while (i < command.length) {
    const c = command[i]
    if (c === undefined) break
    if (inS) {
      cur += c
      if (c === "'") inS = false
      i++
      continue
    }
    if (c === '$' && command[i + 1] === '(' && depth < 5) {
      const cap = captureSubstitution(command, i)
      cur += cap.text
      subs.push(...splitInner(cap.inner, depth + 1))
      i = cap.next
      continue
    }
    if (inD) {
      cur += c
      if (c === '"') inD = false
      i++
      continue
    }
    if (c === "'") {
      inS = true
      cur += c
      i++
      continue
    }
    if (c === '"') {
      inD = true
      cur += c
      i++
      continue
    }
    if (c === '&' && command[i + 1] === '&') {
      push()
      i += 2
      continue
    }
    if (c === '|' && command[i + 1] === '|') {
      push()
      i += 2
      continue
    }
    if (c === '|' || c === ';' || c === '\n') {
      push()
      i++
      continue
    }
    cur += c
    i++
  }
  push()
  return [...parts, ...subs]
}

/** Split on && || ; | and newlines respecting quotes; $() bodies appended as own sub-commands. */
export function splitCompound(command: string): string[] {
  try {
    return splitInner(command, 0)
  } catch {
    return [command.trim()].filter((s) => s.length > 0)
  }
}

/** Whitespace split respecting single/double quotes; quotes are stripped from words. */
export function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ''
  let hasContent = false
  let inS = false
  let inD = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === undefined) break
    if (inS) {
      if (c === "'") inS = false
      else cur += c
      continue
    }
    if (inD) {
      if (c === '"') inD = false
      else cur += c
      continue
    }
    if (c === "'") {
      inS = true
      hasContent = true
      continue
    }
    if (c === '"') {
      inD = true
      hasContent = true
      continue
    }
    if (/\s/.test(c)) {
      if (cur.length > 0 || hasContent) words.push(cur)
      cur = ''
      hasContent = false
      continue
    }
    cur += c
  }
  if (cur.length > 0 || hasContent) words.push(cur)
  return words
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

// Kept in sync by hand with the indexer's secret/generated lists: the indexer
// module is built concurrently, and guards must work even without an index.
const SECRET_BASENAME_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*_rsa*',
  'credentials*',
  '*.tfvars',
  '.npmrc',
  '.netrc',
]
const isSecretBasename = picomatch(SECRET_BASENAME_GLOBS, { dot: true })

const GENERATED_GLOBS = [
  'dist/**',
  '**/dist/**',
  'target/**',
  '**/target/**',
  '*.min.js',
  '**/*.min.js',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
]
const isGeneratedGlob = picomatch(GENERATED_GLOBS, { dot: true })

function normalizeArgPath(arg: string): string {
  let p = arg.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/'
  return p
}

function isSecretArg(arg: string, extraGlobs: string[]): boolean {
  const p = normalizeArgPath(arg)
  if (!p) return false
  const base = posix.basename(p)
  if (isSecretBasename(base)) return true
  if (extraGlobs.length > 0) {
    const extra = picomatch(extraGlobs, { dot: true })
    if (extra(p) || extra(base)) return true
  }
  return false
}

function isGeneratedPath(arg: string): boolean {
  const p = normalizeArgPath(arg)
  if (!p) return false
  return isGeneratedGlob(p) || isGeneratedGlob(posix.basename(p))
}

function isCriticalTarget(arg: string, repoRoot: string): boolean {
  let a = arg
  if (a.length > 1) a = a.replace(/\/+$/, '') || '/'
  if (a === '/' || a === '~' || a === '$HOME' || a === '.' || a === '..' || a === '.git')
    return true
  if (a.includes('$') || a.startsWith('~')) return false
  try {
    return resolve(repoRoot, a) === resolve(repoRoot)
  } catch {
    return false
  }
}

function isWholeRepoTarget(arg: string, repoRoot: string): boolean {
  let a = arg
  if (a.length > 1) a = a.replace(/\/+$/, '') || '/'
  if (a === '.' || a === '/') return true
  if (a.includes('$') || a.startsWith('~')) return false
  try {
    return resolve(repoRoot, a) === resolve(repoRoot)
  } catch {
    return false
  }
}

/** True when a find/grep root is the repo, an ancestor (parent monorepo), /, or implicit whole-repo. */
export function isBroadSearchScope(arg: string, repoRoot: string): boolean {
  if (isWholeRepoTarget(arg, repoRoot)) return true
  if (arg.includes('$') || arg.startsWith('~')) return false
  try {
    const absRepo = resolve(repoRoot)
    const absArg = arg.startsWith('/') ? resolve(arg) : resolve(repoRoot, arg)
    if (absArg === absRepo || absArg === '/') return true
    const prefix = absArg.endsWith('/') ? absArg : `${absArg}/`
    return absRepo.startsWith(prefix)
  } catch {
    return false
  }
}

/** Rules that mean the agent is rediscovering repo structure via shell instead of the index. */
export const BROAD_DISCOVERY_RULES = new Set(['find-broad', 'broad-grep', 'ctx-cli-via-shell', 'mcp-via-shell'])

/** First broad-discovery verdict for a compound command, if any. */
export function broadDiscoveryVerdict(command: string, ctx: BashGuardContext): GuardVerdict | null {
  for (const v of classifyBashCommand(command, ctx)) {
    if (BROAD_DISCOVERY_RULES.has(v.rule)) return v
  }
  return null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const SECRET_READERS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'bat',
  'strings',
  'base64',
  'cp',
  'scp',
  'open',
])
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command'])
// a real pipe (not ||) into a network tool, anywhere in the original command
const NET_PIPE = /(?<!\|)\|(?!\|)\s*(curl|wget|nc|ssh)\b/

function shortFlagLetters(args: string[]): string {
  let out = ''
  for (const w of args) if (/^-[A-Za-z]+$/.test(w)) out += w.slice(1)
  return out
}

function classifySub(sub: string, full: string, ctx: BashGuardContext): GuardVerdict | null {
  if (isMcpShellMisuse(sub)) {
    return {
      tier: 'inefficient',
      rule: 'mcp-via-shell',
      reason: 'mcp__ctx__* tools are not shell commands',
      suggestion: MCP_SHELL_GUARD_SUGGESTION,
    }
  }

  if (isCtxCliMisuse(sub)) {
    return {
      tier: 'inefficient',
      rule: 'ctx-cli-via-shell',
      reason: 'ctx/trace_symbol are indexed lookups, not shell commands',
      suggestion: CTX_CLI_GUARD_SUGGESTION,
    }
  }

  let words = shellWords(sub)
  while (words.length > 1 && WRAPPERS.has(words[0] ?? '')) words = words.slice(1)
  const first = words[0]
  if (!first) return null
  const argv0 = posix.basename(first.replace(/\\/g, '/'))
  const args = words.slice(1)
  const letters = shortFlagLetters(args)
  const positional = args.filter((w) => !w.startsWith('-'))

  // --- severe -------------------------------------------------------------
  if (SECRET_READERS.has(argv0)) {
    for (const a of positional) {
      if (isSecretArg(a, ctx.secretGlobs)) {
        return { tier: 'severe', rule: 'secret-read', reason: `reads secret file ${a}` }
      }
    }
  }

  const dumpsEnv =
    argv0 === 'printenv' ||
    argv0 === 'env' ||
    argv0 === 'set' ||
    (argv0 === 'echo' && /\$\{?[A-Za-z_]/.test(sub))
  if (dumpsEnv && NET_PIPE.test(full)) {
    return { tier: 'severe', rule: 'env-exfil', reason: 'environment piped to network' }
  }

  if (argv0 === 'rm') {
    const recursive = /[rR]/.test(letters) || args.includes('--recursive')
    const force = letters.includes('f') || args.includes('--force')
    if (recursive && force) {
      if (positional.some((t) => isCriticalTarget(t, ctx.repoRoot))) {
        return { tier: 'severe', rule: 'rm-critical', reason: 'recursive delete of critical path' }
      }
      return {
        tier: 'destructive',
        rule: 'rm-rf',
        reason: `recursive force delete of ${positional[0] ?? 'target'}`,
      }
    }
  }

  if (argv0 === 'git') {
    const gitSub = positional[0]
    const rest = positional.slice(1)
    if (gitSub === 'push') {
      const lease = args.some(
        (w) => w === '--force-with-lease' || w.startsWith('--force-with-lease='),
      )
      const force = !lease && (args.includes('--force') || args.includes('-f'))
      const refs = rest.slice(1) // rest[0] is the remote
      const protectedRef = refs.some((r) =>
        r.split(':').some((p) => /^(main|master|release.*)$/.test(p)),
      )
      if (force && (protectedRef || refs.length === 0)) {
        return {
          tier: 'severe',
          rule: 'force-push-protected',
          reason: 'force push to protected branch',
        }
      }
      if (lease) {
        return { tier: 'destructive', rule: 'force-with-lease', reason: 'force push (with lease)' }
      }
    }
    if (gitSub === 'reset' && args.includes('--hard')) {
      return { tier: 'destructive', rule: 'git-reset-hard', reason: 'discards uncommitted changes' }
    }
    if (gitSub === 'clean' && (letters.includes('f') || args.includes('--force'))) {
      return { tier: 'destructive', rule: 'git-clean', reason: 'deletes untracked files' }
    }
    if ((gitSub === 'checkout' || gitSub === 'restore') && rest.includes('.')) {
      return {
        tier: 'destructive',
        rule: 'git-checkout-dot',
        reason: 'discards working tree changes',
      }
    }
  }

  // --- destructive ----------------------------------------------------------
  if (argv0 === 'chmod') {
    const recursive = letters.includes('R') || args.includes('--recursive')
    if (recursive && args.some((w) => /^0?7[0-7]{2}$/.test(w))) {
      return { tier: 'destructive', rule: 'chmod-r', reason: 'recursive permissive chmod' }
    }
  }

  if (/\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b/i.test(sub)) {
    return { tier: 'destructive', rule: 'sql-drop', reason: 'destructive SQL statement' }
  }

  if (argv0 === 'kubectl' && positional[0] === 'delete') {
    return { tier: 'destructive', rule: 'kubectl-delete', reason: 'deletes kubernetes resources' }
  }

  if (argv0 === 'terraform' && (positional[0] === 'apply' || positional[0] === 'destroy')) {
    return { tier: 'destructive', rule: 'terraform-apply', reason: 'modifies real infrastructure' }
  }

  if (argv0 === 'docker' && args.includes('prune')) {
    return { tier: 'destructive', rule: 'docker-prune', reason: 'prunes docker resources' }
  }

  if (argv0 === 'dd' && args.some((w) => /^of=\/dev\//.test(w))) {
    return { tier: 'destructive', rule: 'dd', reason: 'writes directly to a device' }
  }

  // --- inefficient ----------------------------------------------------------
  const isRgLike = argv0 === 'rg' || argv0 === 'ag' || argv0 === 'ack'
  const isGrep = argv0 === 'grep' || argv0 === 'egrep' || argv0 === 'fgrep'
  const grepRecursive = /[rR]/.test(letters) || args.includes('--recursive')
  if (isRgLike || (isGrep && grepRecursive)) {
    const narrowing = args.some(
      (w) =>
        w === '-t' ||
        w === '-g' ||
        w === '--type' ||
        w === '--include' ||
        w === '--glob' ||
        w.startsWith('--type=') ||
        w.startsWith('--include=') ||
        w.startsWith('--glob=') ||
        w.startsWith('-g='),
    )
    if (!narrowing) {
      const valueFlags = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '--max-depth'])
      const pos: string[] = []
      for (let i = 0; i < args.length; i++) {
        const w = args[i]
        if (w === undefined) break
        if (w === '--') {
          for (const r of args.slice(i + 1)) pos.push(r)
          break
        }
        if (w.startsWith('-') && w.length > 1) {
          if (valueFlags.has(w)) i++
          continue
        }
        pos.push(w)
      }
      const pattern = pos[0] ?? '<pattern>'
      const targets = pos.slice(1)
      if (targets.length === 0 || targets.every((t) => isBroadSearchScope(t, ctx.repoRoot))) {
        return {
          tier: 'inefficient',
          rule: 'broad-grep',
          reason: 'repo-wide recursive text search',
          suggestion: `use mcp__ctx__trace_symbol('${pattern}') or mcp__ctx__symbol_search('${pattern}')`,
        }
      }
    }
  }

  if (argv0 === 'find') {
    const paths: string[] = []
    for (const w of args) {
      if (w.startsWith('-') || w === '(' || w === '!') break
      paths.push(w)
    }
    if (paths.length === 0 || paths.every((p) => isBroadSearchScope(p, ctx.repoRoot))) {
      return {
        tier: 'inefficient',
        rule: 'find-broad',
        reason: 'whole-repo or parent-monorepo find',
        suggestion: 'use mcp__ctx__trace_symbol or mcp__ctx__symbol_search — not find',
      }
    }
  }

  if (argv0 === 'cat' || argv0 === 'head') {
    for (const a of positional) {
      if (isGeneratedPath(a)) {
        return {
          tier: 'inefficient',
          rule: 'cat-generated',
          reason: `reads generated file ${a}`,
          suggestion: 'use mcp__ctx__repo_overview instead of reading generated artifacts',
        }
      }
    }
  }

  if (argv0 === 'ls' && (letters.includes('R') || args.includes('--recursive'))) {
    return {
      tier: 'inefficient',
      rule: 'ls-R',
      reason: 'recursive directory listing',
      suggestion: 'use mcp__ctx__repo_tree for a compact tree',
    }
  }

  return null
}

/** One verdict max per sub-command; empty array = clean. Never throws. */
export function classifyBashCommand(command: string, ctx: BashGuardContext): GuardVerdict[] {
  let subCommands: string[]
  try {
    subCommands = splitCompound(command)
  } catch {
    return []
  }
  const verdicts: GuardVerdict[] = []
  for (const sub of subCommands) {
    try {
      const v = classifySub(sub, command, ctx)
      if (v) verdicts.push(v)
    } catch {
      // fail open: never break the session over a guard bug
    }
  }
  return verdicts
}
