import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackageInfo } from '../types'

export interface TsPathsConfig {
  baseUrl: string
  patterns: { alias: string; targets: string[] }[]
}

export interface ResolverContext {
  root: string
  fileSet: Set<string>
  packages: PackageInfo[]
  /** key: repo-rel dir of the tsconfig ('' for root); resolution uses nearest ancestor tsconfig */
  tsPaths: Map<string, TsPathsConfig>
  npmNames: Map<string, PackageInfo>
  /** keys underscore-normalized (fix-core stored as fix_core) */
  crateNames: Map<string, PackageInfo>
  /** repo-rel rust file -> fully-qualified module path 'crate_name::mod::sub' */
  rustMods: Map<string, string>
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

function posixBasename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/** Normalize a repo-relative path, resolving '.' and '..'; null if it escapes the root. */
function normalizeRel(p: string): string | null {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

function joinRel(...segs: string[]): string | null {
  return normalizeRel(segs.filter((s) => s !== '').join('/'))
}

/** Strip // and slash-star comments outside of strings (tsconfig is JSONC). */
function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text.charAt(i)
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text.charAt(i + 1)
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i++
      continue
    }
    if (c === '/' && text.charAt(i + 1) === '*') {
      i += 2
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const stripTrailingCommas = (s: string): string => s.replace(/,(\s*[}\]])/g, '$1')

const stripOneStar = (s: string): string => (s.endsWith('*') ? s.slice(0, -1) : s)

function readTsconfig(root: string, rel: string): TsPathsConfig | null {
  let parsed: unknown
  try {
    const raw = readFileSync(join(root, rel), 'utf8')
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const co = (parsed as Record<string, unknown>)['compilerOptions']
  if (typeof co !== 'object' || co === null) return null
  const opts = co as Record<string, unknown>
  const baseUrl = typeof opts['baseUrl'] === 'string' ? opts['baseUrl'] : '.'
  const pathsRaw = opts['paths']
  const patterns: { alias: string; targets: string[] }[] = []
  if (typeof pathsRaw === 'object' && pathsRaw !== null) {
    for (const [alias, targets] of Object.entries(pathsRaw as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue
      const tg = targets.filter((t): t is string => typeof t === 'string').map(stripOneStar)
      if (tg.length === 0) continue
      patterns.push({ alias: stripOneStar(alias), targets: tg })
    }
  }
  if (patterns.length === 0) return null
  return { baseUrl, patterns }
}

const crateUnderscore = (name: string): string => name.replace(/-/g, '_')

function buildRustMods(
  fileSet: Set<string>,
  packages: PackageInfo[],
  rustModDecls: Map<string, string[]>,
): Map<string, string> {
  const rustMods = new Map<string, string>()
  const sortedFiles = [...fileSet].sort()
  const cargo = packages
    .filter((p) => p.kind === 'cargo')
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))

  for (const pkg of cargo) {
    const prefix = pkg.dir === '' ? '' : pkg.dir + '/'
    const cn = crateUnderscore(pkg.name)
    const roots: string[] = []
    for (const cand of [prefix + 'src/lib.rs', prefix + 'src/main.rs'])
      if (fileSet.has(cand)) roots.push(cand)
    const binPrefix = prefix + 'src/bin/'
    for (const f of sortedFiles)
      if (f.startsWith(binPrefix) && f.endsWith('.rs') && !f.slice(binPrefix.length).includes('/'))
        roots.push(f)

    const queue: string[] = []
    for (const r of roots)
      if (!rustMods.has(r)) {
        rustMods.set(r, cn)
        queue.push(r)
      }
    while (queue.length > 0) {
      const file = queue.shift()
      if (file === undefined) break
      const modPath = rustMods.get(file)
      if (modPath === undefined) continue
      const dir = posixDirname(file)
      const base = posixBasename(file)
      // crate roots and mod.rs: children are siblings; x.rs: children live in x/ (2018 edition)
      const childDirs: string[] = []
      if (base === 'mod.rs' || roots.includes(file)) childDirs.push(dir)
      else {
        const stem = base.replace(/\.rs$/, '')
        childDirs.push(dir === '' ? stem : dir + '/' + stem)
        childDirs.push(dir)
      }
      for (const m of [...(rustModDecls.get(file) ?? [])].sort()) {
        let target: string | undefined
        for (const cd of childDirs) {
          const p = cd === '' ? '' : cd + '/'
          if (fileSet.has(p + m + '.rs')) {
            target = p + m + '.rs'
            break
          }
          if (fileSet.has(p + m + '/mod.rs')) {
            target = p + m + '/mod.rs'
            break
          }
        }
        if (target !== undefined && !rustMods.has(target)) {
          rustMods.set(target, modPath + '::' + m)
          queue.push(target)
        }
      }
    }
  }
  return rustMods
}

export function buildResolverContext(
  root: string,
  fileSet: Set<string>,
  packages: PackageInfo[],
  rustModDecls: Map<string, string[]>,
): ResolverContext {
  const tsPaths = new Map<string, TsPathsConfig>()
  for (const rel of [...fileSet].sort()) {
    if (rel !== 'tsconfig.json' && !rel.endsWith('/tsconfig.json')) continue
    const cfg = readTsconfig(root, rel)
    if (cfg) tsPaths.set(posixDirname(rel), cfg)
  }

  const npmNames = new Map<string, PackageInfo>()
  const crateNames = new Map<string, PackageInfo>()
  for (const p of packages) {
    if (p.kind === 'npm') {
      if (!npmNames.has(p.name)) npmNames.set(p.name, p)
    } else if (!crateNames.has(crateUnderscore(p.name))) {
      crateNames.set(crateUnderscore(p.name), p)
    }
  }

  return {
    root,
    fileSet,
    packages,
    tsPaths,
    npmNames,
    crateNames,
    rustMods: buildRustMods(fileSet, packages, rustModDecls),
  }
}

const TS_SUFFIXES = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js']

function probe(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(base)) return base
  const m = base.match(/\.(js|mjs|cjs)$/)
  if (m) {
    // NodeNext: source written with runtime extension, file on disk is .ts/.mts/.cts
    const repl = m[1] === 'js' ? '.ts' : m[1] === 'mjs' ? '.mts' : '.cts'
    const swapped = base.slice(0, -m[0].length) + repl
    if (fileSet.has(swapped)) return swapped
  }
  for (const s of TS_SUFFIXES) if (fileSet.has(base + s)) return base + s
  for (const s of INDEX_SUFFIXES) if (fileSet.has(base + s)) return base + s
  return null
}

function tryTsPaths(
  spec: string,
  tsDir: string,
  cfg: TsPathsConfig,
  fileSet: Set<string>,
): string | null {
  const matches = cfg.patterns.filter((p) => spec.startsWith(p.alias))
  matches.sort((a, b) => b.alias.length - a.alias.length)
  const baseDir = joinRel(tsDir, cfg.baseUrl)
  if (baseDir === null) return null
  for (const pat of matches) {
    const rest = spec.slice(pat.alias.length)
    for (const target of pat.targets) {
      const cand = joinRel(baseDir, target + rest)
      if (cand === null) continue
      const hit = probe(cand, fileSet)
      if (hit) return hit
    }
  }
  return null
}

function npmNameOf(spec: string): string | null {
  const parts = spec.split('/')
  const first = parts[0]
  if (first === undefined || first === '') return null
  if (first.startsWith('@')) {
    const second = parts[1]
    return second === undefined ? null : first + '/' + second
  }
  return first
}

function resolveTs(fromRel: string, spec: string, ctx: ResolverContext): string | null {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const base = joinRel(posixDirname(fromRel), spec)
    if (base === null) return null
    return probe(base, ctx.fileSet)
  }
  if (spec.startsWith('/') || spec.startsWith('node:')) return null

  // nearest ancestor tsconfig wins; fall through upward if its patterns don't resolve
  for (let dir = posixDirname(fromRel); ; dir = posixDirname(dir)) {
    const cfg = ctx.tsPaths.get(dir)
    if (cfg) {
      const hit = tryTsPaths(spec, dir, cfg, ctx.fileSet)
      if (hit) return hit
    }
    if (dir === '') break
  }

  const name = npmNameOf(spec)
  if (name !== null) {
    const pkg = ctx.npmNames.get(name)
    if (pkg) {
      const entry = pkg.entrypoints[0]
      if (entry !== undefined && ctx.fileSet.has(entry)) return entry
      const fallback = joinRel(pkg.dir, 'src/index.ts')
      if (fallback !== null) {
        const hit = probe(fallback, ctx.fileSet)
        if (hit) return hit
      }
    }
  }
  return null
}

function currentCrate(fromRel: string, ctx: ResolverContext): PackageInfo | null {
  let best: PackageInfo | null = null
  for (const p of ctx.packages) {
    if (p.kind !== 'cargo') continue
    if (p.dir === '' || fromRel.startsWith(p.dir + '/')) {
      if (best === null || p.dir.length > best.dir.length) best = p
    }
  }
  return best
}

function resolveRust(fromRel: string, spec: string, ctx: ResolverContext): string | null {
  const segs = spec.split('::').filter((s) => s !== '')
  const head = segs[0]
  if (head === undefined) return null

  let target: string
  if (head === 'crate') {
    const crate = currentCrate(fromRel, ctx)
    if (crate === null) return null
    target = [crateUnderscore(crate.name), ...segs.slice(1)].join('::')
  } else if (head === 'self') {
    const cur = ctx.rustMods.get(fromRel)
    if (cur === undefined) return null
    target = [cur, ...segs.slice(1)].join('::')
  } else if (head === 'super') {
    const cur = ctx.rustMods.get(fromRel)
    if (cur === undefined) return null
    let parts = cur.split('::')
    let i = 0
    while (segs[i] === 'super') {
      if (parts.length <= 1) return null
      parts = parts.slice(0, -1)
      i++
    }
    target = [...parts, ...segs.slice(i)].join('::')
  } else if (ctx.crateNames.has(head)) {
    target = segs.join('::')
  } else {
    return null // std / external crate
  }

  // longest module-path prefix wins: trailing segments are items, not modules.
  // On a tie (crate roots share the crate name as module path) prefer the
  // library root — `crate::` almost always refers to library items, not a
  // binary's own root.
  const rootPriority = (file: string): number =>
    file === 'lib.rs' || file.endsWith('/lib.rs') ? 2 : file === 'main.rs' || file.endsWith('/main.rs') ? 1 : 0
  let bestFile: string | null = null
  let bestLen = -1
  let bestPrio = -1
  for (const [file, mod] of [...ctx.rustMods.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (target === mod || target.startsWith(mod + '::')) {
      const prio = rootPriority(file)
      if (mod.length > bestLen || (mod.length === bestLen && prio > bestPrio)) {
        bestLen = mod.length
        bestPrio = prio
        bestFile = file
      }
    }
  }
  return bestFile
}

export function resolveImport(fromRel: string, spec: string, ctx: ResolverContext): string | null {
  try {
    if (fromRel.endsWith('.rs')) return resolveRust(fromRel, spec, ctx)
    return resolveTs(fromRel, spec, ctx)
  } catch {
    return null
  }
}
