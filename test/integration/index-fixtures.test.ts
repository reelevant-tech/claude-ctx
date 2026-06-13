import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { loadIndex } from '../../src/core/store/shards'

const FIX = join(__dirname, '..', '..', 'fixtures')

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-idx-'))
  process.env.CLAUDE_CTX_HOME = home
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('ts-app', () => {
  it('indexes a single TS app with secrets, generated, infra, and tsconfig paths', () => {
    const root = join(FIX, 'ts-app')
    const stats = buildIndex(root, { mode: 'full' })
    expect(stats.mode).toBe('full')
    const idx = loadIndex(root)!
    expect(idx).not.toBeNull()
    expect(idx.meta.projectType).toBe('ts-app')

    const inv = idx.files.files['src/billing/invoice.ts']
    expect(inv).toBeTruthy()
    expect(inv!.exports).toContain('createInvoice')
    expect(inv!.tests).toContain('src/billing/invoice.test.ts')

    const env = idx.files.files['.env']
    expect(env).toBeTruthy()
    expect(env!.kind).toBe('secret')
    expect(env!.h).toBe('')
    expect(env!.exports).toEqual([])

    const gen = idx.files.files['src/api/client.gen.ts']
    expect(gen!.risk).toContain('generated')

    const docker = idx.files.files['Dockerfile']
    expect(docker!.risk).toContain('infra')

    // tsconfig paths alias @app/* resolved
    expect(idx.graph.fwd['src/index.ts']).toContain('src/billing/invoice.ts')
    expect(idx.symbols.tokenIndex['invoice']).toBeTruthy()
    expect(idx.commands.commands.some((c) => c.kind === 'test')).toBe(true)
  })
})

describe('ts-monorepo', () => {
  it('resolves cross-package workspace imports', () => {
    const root = join(FIX, 'ts-monorepo')
    buildIndex(root, { mode: 'full' })
    const idx = loadIndex(root)!
    expect(idx.meta.projectType).toBe('ts-monorepo')
    expect(idx.graph.fwd['packages/b/src/index.ts']).toContain('packages/a/src/index.ts')
  })
})

describe('ts-multi', () => {
  it('detects nested manifests with no root manifest', () => {
    const root = join(FIX, 'ts-multi')
    buildIndex(root, { mode: 'full' })
    const idx = loadIndex(root)!
    expect(idx.meta.projectType).toBe('multi')
    expect(idx.meta.packages.length).toBe(2)
  })
})

describe('rust-single', () => {
  it('extracts rust symbols, mod resolution, cfg(test) self-tests, bin entrypoint', () => {
    const root = join(FIX, 'rust-single')
    buildIndex(root, { mode: 'full' })
    const idx = loadIndex(root)!
    expect(idx.meta.projectType).toBe('rust-crate')
    expect(idx.files.files['src/lib.rs']!.exports).toContain('evaluate')
    // use crate::Engine in parser.rs -> lib.rs
    expect(idx.graph.fwd['src/parser.rs']).toContain('src/lib.rs')
    // #[cfg(test)] self-test + tests/ dir mapping
    expect(idx.files.files['src/lib.rs']!.tests).toContain('src/lib.rs')
    const pkg = idx.meta.packages[0]!
    expect(pkg.entrypoints).toContain('src/bin/server.rs')
  })
})

describe('rust-workspace', () => {
  it('resolves cross-crate imports with hyphen->underscore crate names', () => {
    const root = join(FIX, 'rust-workspace')
    buildIndex(root, { mode: 'full' })
    const idx = loadIndex(root)!
    expect(idx.meta.projectType).toBe('rust-workspace')
    expect(idx.graph.fwd['crates/cli/src/main.rs']).toContain('crates/core/src/lib.rs')
    const cards = idx.symbols.symbols.filter((s) => s.f === 'crates/core/src/cards.rs')
    expect(cards.some((s) => s.n === 'Suit' && s.k === 'enum')).toBe(true)
  })
})

describe('incremental', () => {
  it('re-parses only changed files and is a noop on a clean second run', () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-inc-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'inc', main: 'a.ts' }))
      writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n')
      writeFileSync(join(root, 'b.ts'), "import { alpha } from './a'\nexport function beta() {}\n")
      const full = buildIndex(root, { mode: 'full' })
      expect(full.mode).toBe('full')

      // touch a.ts with a new export (bump mtime by rewriting)
      const future = Date.now() / 1000 + 5
      writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\nexport function gamma() {}\n')
      const utimes = require('node:fs').utimesSync as typeof import('node:fs').utimesSync
      utimes(join(root, 'a.ts'), future, future)

      const inc = buildIndex(root, { mode: 'incremental' })
      expect(inc.mode).toBe('incremental')
      const idx = loadIndex(root)!
      expect(idx.files.files['a.ts']!.exports).toContain('gamma')
      expect(idx.files.files['b.ts']!.exports).toContain('beta')

      const noop = buildIndex(root, { mode: 'incremental' })
      expect(noop.mode).toBe('noop')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
