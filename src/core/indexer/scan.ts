import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import picomatch from 'picomatch'
import type { CtxConfig, Lang } from '../types'

export interface ScannedFile {
  rel: string
  abs: string
  size: number
  /** epoch seconds */
  mtime: number
}

export interface ScanResult {
  files: ScannedFile[]
  skippedCount: number
  isGit: boolean
}

const HARD_EXCLUDE_NAMES = new Set(['node_modules', '.git', '.claude-ctx'])

type Matcher = (s: string) => boolean

/** 'target' is only excluded when a Cargo.toml sits next to it or at the repo root. */
function isTargetExcluded(root: string, parentRel: string, hasRootCargo: boolean): boolean {
  if (hasRootCargo) return true
  if (parentRel === '') return false // root Cargo.toml already checked
  return existsSync(join(root, parentRel, 'Cargo.toml'))
}

function isHardExcludedRel(root: string, rel: string, hasRootCargo: boolean): boolean {
  const segs = rel.split('/')
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === undefined) continue
    if (HARD_EXCLUDE_NAMES.has(s)) return true
    // only directory segments named 'target' count, not a file literally named 'target'
    if (s === 'target' && i < segs.length - 1) {
      if (isTargetExcluded(root, segs.slice(0, i).join('/'), hasRootCargo)) return true
    }
  }
  return false
}

interface IgnoreLevel {
  /** rel dir prefix this .gitignore applies under, '' or 'a/b/' (with trailing slash) */
  prefix: string
  ig: Ignore
}

/** Last matching rule wins across nesting levels (gitignore semantics). */
function isGitignored(stack: IgnoreLevel[], rel: string, isDir: boolean): boolean {
  const p = isDir ? rel + '/' : rel
  let ignored = false
  for (const level of stack) {
    if (level.prefix !== '' && !p.startsWith(level.prefix)) continue
    const sub = p.slice(level.prefix.length)
    if (sub === '' || sub === '/') continue
    const r = level.ig.test(sub)
    if (r.ignored) ignored = true
    else if (r.unignored) ignored = false
  }
  return ignored
}

function loadGitignore(absDir: string): Ignore | null {
  const p = join(absDir, '.gitignore')
  try {
    if (!existsSync(p)) return null
    return ignore().add(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

interface WalkState {
  candidates: string[]
  skipped: number
}

function walkDir(
  root: string,
  absDir: string,
  relDir: string,
  stack: IgnoreLevel[],
  excludeMatchers: Matcher[],
  hasRootCargo: boolean,
  state: WalkState,
): void {
  const ig = loadGitignore(absDir)
  const levels = ig ? [...stack, { prefix: relDir === '' ? '' : relDir + '/', ig }] : stack

  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const ent of entries) {
    const rel = relDir === '' ? ent.name : relDir + '/' + ent.name
    if (ent.isSymbolicLink()) {
      state.skipped++
      continue
    }
    if (ent.isDirectory()) {
      if (
        HARD_EXCLUDE_NAMES.has(ent.name) ||
        (ent.name === 'target' && isTargetExcluded(root, relDir, hasRootCargo))
      ) {
        state.skipped++
        continue
      }
      if (isGitignored(levels, rel, true)) continue
      walkDir(root, join(absDir, ent.name), rel, levels, excludeMatchers, hasRootCargo, state)
      continue
    }
    if (!ent.isFile()) {
      state.skipped++
      continue
    }
    if (HARD_EXCLUDE_NAMES.has(ent.name)) {
      state.skipped++
      continue
    }
    if (isGitignored(levels, rel, false)) continue
    if (excludeMatchers.some((m) => m(rel))) {
      state.skipped++
      continue
    }
    state.candidates.push(rel)
  }
}

function gitListFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.toString('utf8').split('\0').filter(Boolean)
}

export function scanRepo(root: string, cfg: CtxConfig): ScanResult {
  const isGit = existsSync(join(root, '.git'))
  const hasRootCargo = existsSync(join(root, 'Cargo.toml'))
  const excludeMatchers = cfg.exclude.map((g) => picomatch(g, { dot: true }))

  let skipped = 0
  let candidates: string[] = []

  if (isGit) {
    let listed: string[] = []
    try {
      listed = gitListFiles(root)
    } catch {
      listed = [] // fail open: broken git => empty scan rather than a crash
    }
    for (const rel of listed) {
      if (isHardExcludedRel(root, rel, hasRootCargo)) {
        skipped++
        continue
      }
      if (excludeMatchers.some((m) => m(rel))) {
        skipped++
        continue
      }
      candidates.push(rel)
    }
  } else {
    const state: WalkState = { candidates: [], skipped: 0 }
    walkDir(root, root, '', [], excludeMatchers, hasRootCargo, state)
    candidates = state.candidates
    skipped += state.skipped
  }

  candidates.sort()

  const maxBytes = cfg.maxFileSizeKb * 1024
  const files: ScannedFile[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (files.length >= cfg.maxFiles) {
      skipped += candidates.length - i
      break
    }
    const rel = candidates[i]
    if (rel === undefined) continue
    const abs = join(root, rel)
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue // raced deletion: not counted, simply gone
    }
    if (!st.isFile()) {
      skipped++
      continue
    }
    if (st.size > maxBytes) {
      skipped++
      continue
    }
    files.push({ rel, abs, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
  }

  return { files, skippedCount: skipped, isGit }
}

export function isBinaryBuffer(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

const EXT_LANG: Record<string, Lang> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  rs: 'rust',
  py: 'py',
  pyi: 'py',
  md: 'md',
  markdown: 'md',
  json: 'json',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
}

export function detectLang(relPath: string): Lang {
  const ext = extname(relPath).slice(1).toLowerCase()
  return EXT_LANG[ext] ?? 'other'
}
