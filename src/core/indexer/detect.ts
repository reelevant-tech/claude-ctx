import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { PackageInfo, ProjectType } from '../types'
import type { ScannedFile } from './scan'

export interface DetectResult {
  projectType: ProjectType
  packages: PackageInfo[]
}

const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function readText(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    return null
  }
}

function readJson(root: string, rel: string): Record<string, unknown> | null {
  const text = readText(root, rel)
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Normalize a manifest-relative specifier ('./src/index.ts') to a repo-relative path. */
function relFromDir(dir: string, spec: string): string {
  let s = spec.replace(/^\.\//, '')
  while (s.startsWith('./')) s = s.slice(2)
  return dir === '' ? s : `${dir}/${s}`
}

function npmWorkspaceGlobs(pkg: Record<string, unknown>): string[] | null {
  const ws = pkg['workspaces']
  if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === 'string')
  if (typeof ws === 'object' && ws !== null) {
    const p = (ws as Record<string, unknown>)['packages']
    if (Array.isArray(p)) return p.filter((g): g is string => typeof g === 'string')
  }
  return null
}

/** Minimal line parser for pnpm-workspace.yaml 'packages:' list — no yaml dep. */
function pnpmWorkspaceGlobs(text: string): string[] {
  const globs: string[] = []
  let inPackages = false
  for (const line of text.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const m = /^\s*-\s*['"]?(.+?)['"]?\s*$/.exec(line)
    if (m && m[1] !== undefined) globs.push(m[1])
    else break // left the list
  }
  return globs
}

/** Extract a [section] body from TOML text (up to the next top-level [header]). */
function tomlSection(text: string, header: string): string | null {
  const re = new RegExp(`^\\[${header}\\]\\s*$`, 'm')
  const m = re.exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const next = /^\s*\[/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

function cargoWorkspaceMembers(text: string): string[] | null {
  const ws = tomlSection(text, 'workspace')
  if (ws === null) return null
  const m = /members\s*=\s*\[([^\]]*)\]/.exec(ws)
  if (!m || m[1] === undefined) return []
  const members: string[] = []
  for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
    if (q[1] !== undefined) members.push(q[1])
  }
  return members
}

function cargoPackageName(text: string): string | null {
  const pkg = tomlSection(text, 'package')
  if (pkg === null) return null
  const m = /name\s*=\s*"(.+)"/.exec(pkg)
  return m && m[1] !== undefined ? m[1] : null
}

function npmEntrypoints(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
  fileSet: Set<string>,
): string[] {
  const candidates: string[] = []
  const bin = manifest['bin']
  if (typeof bin === 'string') candidates.push(bin)
  else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    for (const k of Object.keys(bin).sort()) {
      const v = (bin as Record<string, unknown>)[k]
      if (typeof v === 'string') candidates.push(v)
    }
  }
  for (const key of ['main', 'module'] as const) {
    const v = manifest[key]
    if (typeof v === 'string') candidates.push(v)
  }
  const exp = manifest['exports']
  const dot =
    typeof exp === 'string'
      ? exp
      : typeof exp === 'object' && exp !== null && !Array.isArray(exp)
        ? (exp as Record<string, unknown>)['.']
        : undefined
  if (typeof dot === 'string') candidates.push(dot)
  else if (typeof dot === 'object' && dot !== null && !Array.isArray(dot)) {
    for (const cond of ['import', 'require', 'default']) {
      const v = (dot as Record<string, unknown>)[cond]
      if (typeof v === 'string' && SRC_EXTS.some((e) => v.endsWith(e))) candidates.push(v)
    }
  }

  const out: string[] = []
  for (const c of candidates) {
    const rel = relFromDir(dir, c)
    if (fileSet.has(rel) && !out.includes(rel)) out.push(rel)
  }
  if (out.length === 0) {
    for (const fb of ['src/index.ts', 'index.ts']) {
      const rel = relFromDir(dir, fb)
      if (fileSet.has(rel)) {
        out.push(rel)
        break
      }
    }
  }
  return out
}

function cargoEntrypoints(dir: string, manifestText: string, fileSet: Set<string>): string[] {
  const out: string[] = []
  for (const std of ['src/lib.rs', 'src/main.rs']) {
    const rel = relFromDir(dir, std)
    if (fileSet.has(rel)) out.push(rel)
  }
  const binPrefix = relFromDir(dir, 'src/bin/')
  const binFiles = [...fileSet]
    .filter((f) => {
      if (!f.startsWith(binPrefix) || !f.endsWith('.rs')) return false
      return !f.slice(binPrefix.length).includes('/')
    })
    .sort()
  for (const f of binFiles) if (!out.includes(f)) out.push(f)
  // [[bin]] path entries
  for (const block of manifestText.split(/^\[\[bin\]\]\s*$/m).slice(1)) {
    const next = /^\s*\[/m.exec(block)
    const scoped = next ? block.slice(0, next.index) : block
    const m = /path\s*=\s*"(.+)"/.exec(scoped)
    if (m && m[1] !== undefined) {
      const rel = relFromDir(dir, m[1])
      if (fileSet.has(rel) && !out.includes(rel)) out.push(rel)
    }
  }
  return out
}

interface ManifestRef {
  dir: string
  kind: 'npm' | 'cargo'
  manifest: string
}

function dirOf(manifestRel: string): string {
  const i = manifestRel.lastIndexOf('/')
  return i === -1 ? '' : manifestRel.slice(0, i)
}

function expandWorkspaceGlobs(
  globs: string[],
  fileSet: Set<string>,
  manifestName: 'package.json' | 'Cargo.toml',
): string[] {
  const found = new Set<string>()
  for (const g of globs) {
    if (g.startsWith('!')) continue // exclusion globs unsupported, kept simple
    const pattern = `${g.replace(/\/+$/, '')}/${manifestName}`
    const isMatch = picomatch(pattern, { dot: true })
    for (const f of fileSet) {
      if (isMatch(f)) found.add(f)
    }
  }
  return [...found].sort()
}

export function detectProject(root: string, files: ScannedFile[]): DetectResult {
  const fileSet = new Set(files.map((f) => f.rel))
  const manifests = new Map<string, ManifestRef>()
  const addManifest = (rel: string, kind: 'npm' | 'cargo') => {
    if (rel.split('/').includes('node_modules')) return
    if (!manifests.has(rel)) manifests.set(rel, { dir: dirOf(rel), kind, manifest: rel })
  }

  const rootPkg = fileSet.has('package.json') ? readJson(root, 'package.json') : null
  const rootCargoText = fileSet.has('Cargo.toml') ? readText(root, 'Cargo.toml') : null
  const pnpmText = fileSet.has('pnpm-workspace.yaml') ? readText(root, 'pnpm-workspace.yaml') : null

  let npmWsGlobs: string[] | null = rootPkg ? npmWorkspaceGlobs(rootPkg) : null
  if (pnpmText !== null) {
    const globs = pnpmWorkspaceGlobs(pnpmText)
    if (globs.length > 0) npmWsGlobs = [...(npmWsGlobs ?? []), ...globs]
  }
  const cargoWsMembers = rootCargoText !== null ? cargoWorkspaceMembers(rootCargoText) : null

  const isNpmWorkspaceRoot = npmWsGlobs !== null
  const isCargoWorkspaceRoot = cargoWsMembers !== null

  if (isNpmWorkspaceRoot && npmWsGlobs) {
    for (const rel of expandWorkspaceGlobs(npmWsGlobs, fileSet, 'package.json')) {
      addManifest(rel, 'npm')
    }
  }
  if (isCargoWorkspaceRoot && cargoWsMembers) {
    for (const rel of expandWorkspaceGlobs(cargoWsMembers, fileSet, 'Cargo.toml')) {
      addManifest(rel, 'cargo')
    }
  }

  // Nested manifests (depth <= 3 slashes) count when the root is not a workspace root.
  const scanNested = (kind: 'npm' | 'cargo', name: string, wsRoot: boolean) => {
    if (wsRoot) return
    for (const f of fileSet) {
      if (!f.endsWith('/' + name)) continue
      if (f.split('/').length - 1 <= 3) addManifest(f, kind)
    }
  }
  scanNested('npm', 'package.json', isNpmWorkspaceRoot)
  scanNested('cargo', 'Cargo.toml', isCargoWorkspaceRoot)

  // Rule: the root manifest is a package only when it has entrypoints or declares no workspaces.
  const rootRefs: ManifestRef[] = []
  if (rootPkg !== null) rootRefs.push({ dir: '', kind: 'npm', manifest: 'package.json' })
  if (rootCargoText !== null) rootRefs.push({ dir: '', kind: 'cargo', manifest: 'Cargo.toml' })

  const buildPackage = (ref: ManifestRef): Omit<PackageInfo, 'id'> | null => {
    if (ref.kind === 'npm') {
      const pkg = ref.dir === '' ? rootPkg : readJson(root, ref.manifest)
      if (pkg === null) return null
      const name =
        typeof pkg['name'] === 'string' && pkg['name'] !== ''
          ? pkg['name']
          : ref.dir === ''
            ? 'root'
            : (ref.dir.split('/').pop() ?? ref.dir)
      return {
        name,
        dir: ref.dir,
        kind: 'npm',
        manifest: ref.manifest,
        entrypoints: npmEntrypoints(root, ref.dir, pkg, fileSet),
      }
    }
    const text = ref.dir === '' ? rootCargoText : readText(root, ref.manifest)
    if (text === null) return null
    const name =
      cargoPackageName(text) ?? (ref.dir === '' ? 'root' : (ref.dir.split('/').pop() ?? ref.dir))
    return {
      name,
      dir: ref.dir,
      kind: 'cargo',
      manifest: ref.manifest,
      entrypoints: cargoEntrypoints(ref.dir, text, fileSet),
    }
  }

  const built: Omit<PackageInfo, 'id'>[] = []
  for (const ref of rootRefs) {
    const isWsRoot = ref.kind === 'npm' ? isNpmWorkspaceRoot : isCargoWorkspaceRoot
    const pkg = buildPackage(ref)
    if (pkg === null) continue
    if (!isWsRoot || pkg.entrypoints.length > 0) built.push(pkg)
  }
  for (const ref of [...manifests.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    if (ref.dir === '') continue // root handled above
    const pkg = buildPackage(ref)
    if (pkg !== null) built.push(pkg)
  }

  built.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.kind < b.kind ? -1 : 1))
  const packages: PackageInfo[] = built.map((p, i) => ({ id: i, ...p }))

  const kinds = new Set(packages.map((p) => p.kind))
  let projectType: ProjectType
  if (packages.length === 0) projectType = 'unknown'
  else if (kinds.size > 1) projectType = 'mixed'
  else if (isNpmWorkspaceRoot && kinds.has('npm')) projectType = 'ts-monorepo'
  else if (isCargoWorkspaceRoot && kinds.has('cargo')) projectType = 'rust-workspace'
  else if (packages.length === 1) projectType = kinds.has('npm') ? 'ts-app' : 'rust-crate'
  else projectType = 'multi'

  return { projectType, packages }
}

/** Deepest package whose dir prefix-matches rel; '' (root) matches everything. */
export function assignPackage(rel: string, packages: PackageInfo[]): number {
  let best = -1
  let bestLen = -1
  for (const p of packages) {
    if (p.dir === '' || rel === p.dir || rel.startsWith(p.dir + '/')) {
      if (p.dir.length > bestLen) {
        bestLen = p.dir.length
        best = p.id
      }
    }
  }
  return best
}
