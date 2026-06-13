import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CtxConfig, PackageInfo } from '../../src/core/types'
import { scanRepo } from '../../src/core/indexer/scan'
import { assignPackage, detectProject } from '../../src/core/indexer/detect'

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url))

function makeCfg(): CtxConfig {
  return {
    packBudgetTokens: 1500,
    overviewBudgetTokens: 700,
    inject: { sessionStart: true, userPromptSubmit: true },
    guard: { bash: 'warn', edits: 'warn', reads: 'warn' },
    exclude: [],
    riskyGlobs: [],
    secretGlobs: [],
    maxFileSizeKb: 512,
    maxFiles: 20000,
    bgIndexThresholdFiles: 2000,
    mcpMaxResultTokens: 2000,
    cochangeCommits: 1000,
  }
}

function detectFixture(name: string) {
  const root = path.join(FIXTURES, name)
  const { files } = scanRepo(root, makeCfg())
  return detectProject(root, files)
}

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function detectTmp(root: string) {
  return detectProject(root, scanRepo(root, makeCfg()).files)
}

describe('detectProject fixtures', () => {
  it('ts-app: single npm package, src/index.ts via fallback', () => {
    const res = detectFixture('ts-app')
    expect(res.projectType).toBe('ts-app')
    expect(res.packages).toHaveLength(1)
    const pkg = res.packages[0]
    expect(pkg).toBeDefined()
    expect(pkg?.id).toBe(0)
    expect(pkg?.name).toBe('ts-app')
    expect(pkg?.dir).toBe('')
    expect(pkg?.kind).toBe('npm')
    expect(pkg?.manifest).toBe('package.json')
    expect(pkg?.entrypoints).toEqual(['src/index.ts'])
  })

  it('ts-monorepo: pnpm workspace, root excluded (no entrypoints), 2 members', () => {
    const res = detectFixture('ts-monorepo')
    expect(res.projectType).toBe('ts-monorepo')
    expect(res.packages.map((p) => p.dir)).toEqual(['packages/a', 'packages/b'])
    expect(res.packages.map((p) => p.name)).toEqual(['@fix/a', '@fix/b'])
    expect(res.packages.map((p) => p.id)).toEqual([0, 1])
    expect(res.packages[0]?.entrypoints).toEqual(['packages/a/src/index.ts'])
    // b has no main: fallback src/index.ts inside the package dir
    expect(res.packages[1]?.entrypoints).toEqual(['packages/b/src/index.ts'])
  })

  it('ts-multi: two nested npm packages, no workspace root => multi', () => {
    const res = detectFixture('ts-multi')
    expect(res.projectType).toBe('multi')
    expect(res.packages.map((p) => p.dir)).toEqual(['services/api', 'tools/scripts'])
    expect(res.packages.map((p) => p.name)).toEqual(['svc-api', 'tool-scripts'])
    expect(res.packages.every((p) => p.kind === 'npm')).toBe(true)
  })

  it('rust-single: rust-crate with lib, main and bin entrypoints', () => {
    const res = detectFixture('rust-single')
    expect(res.projectType).toBe('rust-crate')
    expect(res.packages).toHaveLength(1)
    const pkg = res.packages[0]
    expect(pkg?.name).toBe('eco-fixture')
    expect(pkg?.kind).toBe('cargo')
    expect(pkg?.manifest).toBe('Cargo.toml')
    // [[bin]] path duplicates the src/bin glob hit: must be deduped
    expect(pkg?.entrypoints).toEqual(['src/lib.rs', 'src/main.rs', 'src/bin/server.rs'])
  })

  it('rust-workspace: members expanded from crates/*, virtual root excluded', () => {
    const res = detectFixture('rust-workspace')
    expect(res.projectType).toBe('rust-workspace')
    expect(res.packages.map((p) => p.dir)).toEqual(['crates/cli', 'crates/core'])
    expect(res.packages.map((p) => p.name)).toEqual(['fix-cli', 'fix-core'])
    expect(res.packages[0]?.entrypoints).toEqual(['crates/cli/src/main.rs'])
    expect(res.packages[1]?.entrypoints).toEqual(['crates/core/src/lib.rs'])
  })
})

describe('detectProject synthetic repos', () => {
  it('empty repo => unknown', () => {
    const res = detectTmp(tmpRepo())
    expect(res.projectType).toBe('unknown')
    expect(res.packages).toEqual([])
  })

  it('npm + cargo packages => mixed', () => {
    const root = tmpRepo()
    write(root, 'package.json', '{"name":"top"}')
    write(root, 'src/index.ts', 'x')
    write(root, 'native/Cargo.toml', '[package]\nname = "native"\n')
    write(root, 'native/src/lib.rs', 'x')
    const res = detectTmp(root)
    expect(res.projectType).toBe('mixed')
    expect(res.packages.map((p) => [p.dir, p.kind])).toEqual([
      ['', 'npm'],
      ['native', 'cargo'],
    ])
  })

  it('npm entrypoints from bin/main/module/exports in order, deduped', () => {
    const root = tmpRepo()
    write(
      root,
      'package.json',
      JSON.stringify({
        name: 'entry-test',
        bin: { ct: './src/cli.ts' },
        main: './src/main.ts',
        module: './src/main.ts',
        exports: { '.': { import: './src/index.mts', require: './missing.cjs' } },
      }),
    )
    write(root, 'src/cli.ts', 'x')
    write(root, 'src/main.ts', 'x')
    write(root, 'src/index.mts', 'x')
    const res = detectTmp(root)
    expect(res.packages[0]?.entrypoints).toEqual(['src/cli.ts', 'src/main.ts', 'src/index.mts'])
  })

  it('npm workspaces field in package.json (array form)', () => {
    const root = tmpRepo()
    write(root, 'package.json', '{"name":"ws-root","workspaces":["pkgs/*"]}')
    write(root, 'pkgs/x/package.json', '{"name":"x"}')
    write(root, 'pkgs/x/index.ts', 'x')
    const res = detectTmp(root)
    expect(res.projectType).toBe('ts-monorepo')
    expect(res.packages.map((p) => p.name)).toEqual(['x'])
    expect(res.packages[0]?.entrypoints).toEqual(['pkgs/x/index.ts'])
  })

  it('workspace root WITH entrypoints is included as a package', () => {
    const root = tmpRepo()
    write(root, 'package.json', '{"name":"ws-root","workspaces":["pkgs/*"]}')
    write(root, 'src/index.ts', 'x')
    write(root, 'pkgs/x/package.json', '{"name":"x"}')
    const res = detectTmp(root)
    expect(res.projectType).toBe('ts-monorepo')
    expect(res.packages.map((p) => p.name)).toEqual(['ws-root', 'x'])
  })

  it('cargo [[bin]] path outside src/bin is picked up', () => {
    const root = tmpRepo()
    write(root, 'Cargo.toml', '[package]\nname = "tools"\n\n[[bin]]\npath = "src/tools/gen.rs"\n')
    write(root, 'src/tools/gen.rs', 'x')
    const res = detectTmp(root)
    expect(res.projectType).toBe('rust-crate')
    expect(res.packages[0]?.entrypoints).toEqual(['src/tools/gen.rs'])
  })

  it('nested manifests deeper than 3 slashes are ignored', () => {
    const root = tmpRepo()
    write(root, 'a/b/c/package.json', '{"name":"ok-depth"}')
    write(root, 'a/b/c/d/package.json', '{"name":"too-deep"}')
    const res = detectTmp(root)
    expect(res.packages.map((p) => p.name)).toEqual(['ok-depth'])
  })
})

describe('assignPackage', () => {
  const mk = (id: number, dir: string): PackageInfo => ({
    id,
    name: `p${id}`,
    dir,
    kind: 'npm',
    manifest: dir === '' ? 'package.json' : `${dir}/package.json`,
    entrypoints: [],
  })

  it('picks the deepest matching dir', () => {
    const pkgs = [mk(0, ''), mk(1, 'packages/a'), mk(2, 'packages/a/sub')]
    expect(assignPackage('packages/a/sub/x.ts', pkgs)).toBe(2)
    expect(assignPackage('packages/a/y.ts', pkgs)).toBe(1)
    expect(assignPackage('packages/ab/z.ts', pkgs)).toBe(0)
    expect(assignPackage('src/root.ts', pkgs)).toBe(0)
  })

  it('returns -1 when nothing matches', () => {
    const pkgs = [mk(0, 'a')]
    expect(assignPackage('b/c.ts', pkgs)).toBe(-1)
    expect(assignPackage('a/c.ts', pkgs)).toBe(0)
    expect(assignPackage('a', pkgs)).toBe(0)
  })

  it('root package matches everything', () => {
    expect(assignPackage('anything/at/all.ts', [mk(0, '')])).toBe(0)
    expect(assignPackage('x.ts', [])).toBe(-1)
  })
})
