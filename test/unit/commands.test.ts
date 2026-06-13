import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCommands } from '../../src/core/indexer/commands'
import type { PackageInfo } from '../../src/core/types'

const npmPkg = (over: Partial<PackageInfo> = {}): PackageInfo => ({
  id: 0,
  name: 'root',
  dir: '',
  kind: 'npm',
  manifest: 'package.json',
  entrypoints: [],
  ...over,
})

function tmpRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
}

describe('extractCommands', () => {
  it('extracts npm scripts + Makefile targets with kinds and npm test shorthand', () => {
    const root = tmpRepo()
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'root',
        scripts: {
          test: 'vitest run',
          build: 'tsc',
          dev: 'node dev.js',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    )
    writeFileSync(
      path.join(root, 'Makefile'),
      '.PHONY: deploy\n%.o: %.c\n\tcc\ndeploy:\n\tship\nfmt:\n\tprettier\n',
    )

    const shard = extractCommands(root, [npmPkg()])
    const byCmd = new Map(shard.commands.map((c) => [c.cmd, c]))

    expect(byCmd.get('npm test')).toMatchObject({
      kind: 'test',
      src: 'package.json:scripts.test',
      pkg: 0,
    })
    expect(byCmd.has('npm run test')).toBe(false)
    expect(byCmd.get('npm run build')?.kind).toBe('build')
    expect(byCmd.get('npm run dev')?.kind).toBe('dev')
    expect(byCmd.get('npm run lint')?.kind).toBe('lint')
    expect(byCmd.get('npm run typecheck')?.kind).toBe('typecheck')
    expect(byCmd.get('make deploy')).toMatchObject({ kind: 'other', src: 'Makefile:deploy' })
    expect(byCmd.get('make fmt')?.kind).toBe('other')
    expect(byCmd.has('make .PHONY')).toBe(false)

    // rank ordering: test first
    expect(shard.commands[0]?.kind).toBe('test')
  })

  it('detects pnpm from lockfile and prefixes -F for non-root packages', () => {
    const root = tmpRepo()
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }))
    mkdirSync(path.join(root, 'packages/a'), { recursive: true })
    writeFileSync(
      path.join(root, 'packages/a/package.json'),
      JSON.stringify({ scripts: { test: 't', build: 'b' } }),
    )

    const shard = extractCommands(root, [
      npmPkg(),
      npmPkg({ id: 1, name: '@x/a', dir: 'packages/a', manifest: 'packages/a/package.json' }),
    ])
    const cmds = shard.commands.map((c) => c.cmd)
    expect(cmds).toContain('pnpm run test') // no npm-style shorthand for pnpm
    expect(cmds).toContain('pnpm -F @x/a run test')
    expect(cmds).toContain('pnpm -F @x/a run build')
  })

  it('detects yarn workspaces prefix', () => {
    const root = tmpRepo()
    writeFileSync(path.join(root, 'yarn.lock'), '')
    mkdirSync(path.join(root, 'pkgs/b'), { recursive: true })
    writeFileSync(
      path.join(root, 'pkgs/b/package.json'),
      JSON.stringify({ scripts: { lint: 'l' } }),
    )
    const shard = extractCommands(root, [
      npmPkg({ id: 3, name: 'b', dir: 'pkgs/b', manifest: 'pkgs/b/package.json' }),
    ])
    expect(shard.commands.map((c) => c.cmd)).toContain('yarn workspace b run lint')
  })

  it('cargo: -p only for multi-crate workspaces', () => {
    const root = tmpRepo()
    const single = extractCommands(root, [
      npmPkg({ kind: 'cargo', name: 'solo', manifest: 'Cargo.toml' }),
    ])
    expect(single.commands.map((c) => c.cmd)).toEqual(['cargo test', 'cargo build', 'cargo run'])

    const multi = extractCommands(root, [
      npmPkg({ kind: 'cargo', name: 'a', manifest: 'crates/a/Cargo.toml', dir: 'crates/a' }),
      npmPkg({ id: 1, kind: 'cargo', name: 'b', manifest: 'crates/b/Cargo.toml', dir: 'crates/b' }),
    ])
    const cmds = multi.commands.map((c) => c.cmd)
    expect(cmds).toContain('cargo test -p a')
    expect(cmds).toContain('cargo test -p b')
    expect(cmds).toContain('cargo run -p b')
    // rank: both tests before any build
    expect(cmds.slice(0, 2)).toEqual(['cargo test -p a', 'cargo test -p b'])
  })

  it('justfile targets are extracted', () => {
    const root = tmpRepo()
    writeFileSync(
      path.join(root, 'justfile'),
      "build:\n  cargo build\ntest filter='':\n  cargo test\n",
    )
    const shard = extractCommands(root, [])
    const byCmd = new Map(shard.commands.map((c) => [c.cmd, c]))
    expect(byCmd.get('just build')?.kind).toBe('build')
    expect(byCmd.get('just test')?.kind).toBe('test')
  })

  it('caps at 15 commands', () => {
    const root = tmpRepo()
    const scripts: Record<string, string> = {}
    for (let i = 0; i < 25; i++) scripts[`script-${String(i).padStart(2, '0')}`] = 'x'
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }))
    const shard = extractCommands(root, [npmPkg()])
    expect(shard.commands.length).toBe(15)
  })

  it('fails open on malformed package.json and missing Makefile', () => {
    const root = tmpRepo()
    writeFileSync(path.join(root, 'package.json'), '{not json')
    expect(extractCommands(root, [npmPkg()])).toEqual({ commands: [] })
  })
})
