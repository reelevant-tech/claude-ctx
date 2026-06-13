import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandInfo, CommandsShard, PackageInfo } from '../types'

type Pm = 'pnpm' | 'yarn' | 'bun' | 'npm'

function detectPm(root: string): Pm {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function kindFromName(name: string): CommandInfo['kind'] {
  if (name.startsWith('test')) return 'test'
  if (name === 'build') return 'build'
  if (name === 'dev' || name === 'start') return 'dev'
  if (name === 'lint') return 'lint'
  if (name === 'typecheck' || name === 'check-types') return 'typecheck'
  return 'other'
}

const RANK: Record<CommandInfo['kind'], number> = {
  test: 0,
  build: 1,
  dev: 2,
  typecheck: 3,
  lint: 4,
  run: 5,
  other: 6,
}

function npmCommands(root: string, pm: Pm, pkg: PackageInfo, out: CommandInfo[]): void {
  let scripts: Record<string, unknown>
  try {
    const json = JSON.parse(readFileSync(join(root, pkg.manifest), 'utf8')) as Record<
      string,
      unknown
    >
    const s = json['scripts']
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return
    scripts = s as Record<string, unknown>
  } catch {
    return
  }
  const isRoot = pkg.dir === ''
  for (const name of Object.keys(scripts).sort()) {
    if (typeof scripts[name] !== 'string') continue
    let cmd: string
    if (pm === 'pnpm' && !isRoot) cmd = `pnpm -F ${pkg.name} run ${name}`
    else if (pm === 'yarn' && !isRoot) cmd = `yarn workspace ${pkg.name} run ${name}`
    else if (pm === 'npm' && name === 'test') cmd = 'npm test'
    else cmd = `${pm} run ${name}`
    out.push({ cmd, src: `${pkg.manifest}:scripts.${name}`, kind: kindFromName(name), pkg: pkg.id })
  }
}

function cargoCommands(pkg: PackageInfo, single: boolean, out: CommandInfo[]): void {
  const suffix = single ? '' : ` -p ${pkg.name}`
  const entries: [string, CommandInfo['kind']][] = [
    [`cargo test${suffix}`, 'test'],
    [`cargo build${suffix}`, 'build'],
    [`cargo run${suffix}`, 'run'],
  ]
  for (const [cmd, kind] of entries) out.push({ cmd, src: pkg.manifest, kind, pkg: pkg.id })
}

const MAKE_TARGET = /^([a-zA-Z0-9_-]+):/
const JUST_TARGET = /^([a-zA-Z0-9_-]+)(\s.*)?:$/

function makefileCommands(root: string, out: CommandInfo[]): void {
  let text: string
  try {
    text = readFileSync(join(root, 'Makefile'), 'utf8')
  } catch {
    return
  }
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = MAKE_TARGET.exec(line) // .PHONY and pattern rules don't match this regex
    const target = m?.[1]
    if (!target || seen.has(target)) continue
    seen.add(target)
    out.push({ cmd: `make ${target}`, src: `Makefile:${target}`, kind: kindFromName(target) })
  }
}

function justfileCommands(root: string, out: CommandInfo[]): void {
  let text: string
  try {
    text = readFileSync(join(root, 'justfile'), 'utf8')
  } catch {
    return
  }
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = JUST_TARGET.exec(line)
    const target = m?.[1]
    if (!target || seen.has(target)) continue
    seen.add(target)
    out.push({ cmd: `just ${target}`, src: `justfile:${target}`, kind: kindFromName(target) })
  }
}

export function extractCommands(root: string, packages: PackageInfo[]): CommandsShard {
  const out: CommandInfo[] = []
  const pm = detectPm(root)
  const cargoCount = packages.filter((p) => p.kind === 'cargo').length
  const sorted = [...packages].sort((a, b) => a.id - b.id)
  for (const pkg of sorted) {
    if (pkg.kind === 'npm') npmCommands(root, pm, pkg, out)
    else cargoCommands(pkg, cargoCount === 1, out)
  }
  makefileCommands(root, out)
  justfileCommands(root, out)

  out.sort((a, b) => {
    const r = RANK[a.kind] - RANK[b.kind]
    if (r !== 0) return r
    const pa = a.pkg ?? Number.MAX_SAFE_INTEGER
    const pb = b.pkg ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0
  })
  return { commands: out.slice(0, 15) }
}
