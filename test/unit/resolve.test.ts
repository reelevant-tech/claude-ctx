import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PackageInfo } from '../../src/core/types'
import { buildResolverContext, resolveImport } from '../../src/core/indexer/resolve'
import { buildGraph, shortestPaths } from '../../src/core/indexer/graph'

function pkg(
  id: number,
  name: string,
  dir: string,
  kind: 'npm' | 'cargo',
  entrypoints: string[] = [],
): PackageInfo {
  const manifestName = kind === 'npm' ? 'package.json' : 'Cargo.toml'
  return {
    id,
    name,
    dir,
    kind,
    manifest: dir === '' ? manifestName : `${dir}/${manifestName}`,
    entrypoints,
  }
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
}

describe('resolveImport ts/js', () => {
  it('resolves relative imports with extension probing', () => {
    const root = tmpRoot()
    const fileSet = new Set([
      'src/billing/index.ts',
      'src/billing/invoice.ts',
      'src/util/index.ts',
      'src/x.ts',
      'src/a.ts',
    ])
    const ctx = buildResolverContext(root, fileSet, [], new Map())
    expect(resolveImport('src/billing/index.ts', './invoice', ctx)).toBe('src/billing/invoice.ts')
    expect(resolveImport('src/a.ts', './util', ctx)).toBe('src/util/index.ts')
    expect(resolveImport('src/billing/invoice.ts', '../x', ctx)).toBe('src/x.ts')
    expect(resolveImport('src/a.ts', './missing', ctx)).toBeNull()
  })

  it('resolves NodeNext ./x.js to x.ts', () => {
    const root = tmpRoot()
    const ctx = buildResolverContext(root, new Set(['src/a.ts', 'src/x.ts']), [], new Map())
    expect(resolveImport('src/a.ts', './x.js', ctx)).toBe('src/x.ts')
  })

  it('resolves tsconfig paths aliases (wildcard + exact), tolerating JSONC', () => {
    const root = tmpRoot()
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      `{
        // line comment
        "compilerOptions": {
          /* block comment */
          "baseUrl": ".",
          "paths": {
            "@app/*": ["src/*"],
            "app-config": ["src/config/index.ts"],
          }
        }
      }`,
    )
    const fileSet = new Set([
      'tsconfig.json',
      'src/main.ts',
      'src/billing/invoice.ts',
      'src/config/index.ts',
    ])
    const ctx = buildResolverContext(root, fileSet, [], new Map())
    expect(resolveImport('src/main.ts', '@app/billing/invoice', ctx)).toBe('src/billing/invoice.ts')
    expect(resolveImport('src/main.ts', 'app-config', ctx)).toBe('src/config/index.ts')
  })

  it('prefers the nearest ancestor tsconfig', () => {
    const root = tmpRoot()
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['rootlib/*'] } } }),
    )
    fs.mkdirSync(path.join(root, 'pkg/web'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'pkg/web/tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } } }),
    )
    const fileSet = new Set([
      'tsconfig.json',
      'pkg/web/tsconfig.json',
      'pkg/web/src/a.ts',
      'pkg/web/lib/x.ts',
      'rootlib/x.ts',
      'src/b.ts',
    ])
    const ctx = buildResolverContext(root, fileSet, [], new Map())
    expect(resolveImport('pkg/web/src/a.ts', '@lib/x', ctx)).toBe('pkg/web/lib/x.ts')
    expect(resolveImport('src/b.ts', '@lib/x', ctx)).toBe('rootlib/x.ts')
  })

  it('resolves workspace npm names to entrypoint or src/index.ts probe', () => {
    const root = tmpRoot()
    const packages = [
      pkg(0, '@fix/a', 'packages/a', 'npm'),
      pkg(1, '@fix/b', 'packages/b', 'npm', ['packages/b/lib/main.ts']),
    ]
    const fileSet = new Set([
      'packages/a/src/index.ts',
      'packages/b/lib/main.ts',
      'packages/b/src/main.ts',
    ])
    const ctx = buildResolverContext(root, fileSet, packages, new Map())
    expect(resolveImport('packages/b/src/main.ts', '@fix/a', ctx)).toBe('packages/a/src/index.ts')
    expect(resolveImport('packages/b/src/main.ts', '@fix/a/utils', ctx)).toBe(
      'packages/a/src/index.ts',
    )
    expect(resolveImport('packages/a/src/index.ts', '@fix/b', ctx)).toBe('packages/b/lib/main.ts')
  })

  it('returns null for external packages', () => {
    const root = tmpRoot()
    const ctx = buildResolverContext(root, new Set(['src/a.ts']), [], new Map())
    expect(resolveImport('src/a.ts', 'zod', ctx)).toBeNull()
    expect(resolveImport('src/a.ts', 'node:fs', ctx)).toBeNull()
  })
})

describe('resolveImport rust', () => {
  it('resolves crate:: to the deepest module file', () => {
    const root = tmpRoot()
    const fileSet = new Set(['Cargo.toml', 'src/lib.rs', 'src/cards.rs'])
    const decls = new Map([['src/lib.rs', ['cards']]])
    const ctx = buildResolverContext(root, fileSet, [pkg(0, 'fix-core', '', 'cargo')], decls)
    expect(ctx.rustMods.get('src/lib.rs')).toBe('fix_core')
    expect(ctx.rustMods.get('src/cards.rs')).toBe('fix_core::cards')
    expect(resolveImport('src/lib.rs', 'crate::cards::shuffle', ctx)).toBe('src/cards.rs')
    expect(resolveImport('src/cards.rs', 'crate::cards', ctx)).toBe('src/cards.rs')
  })

  it('resolves cross-crate paths via underscore-normalized crate names', () => {
    const root = tmpRoot()
    const packages = [
      pkg(0, 'fix-core', 'crates/core', 'cargo'),
      pkg(1, 'fix-cli', 'crates/cli', 'cargo'),
    ]
    const fileSet = new Set(['crates/core/src/lib.rs', 'crates/cli/src/main.rs'])
    const ctx = buildResolverContext(root, fileSet, packages, new Map())
    expect(resolveImport('crates/cli/src/main.rs', 'fix_core::evaluate_hand', ctx)).toBe(
      'crates/core/src/lib.rs',
    )
    expect(resolveImport('crates/cli/src/main.rs', 'crate::missing_mod', ctx)).toBe(
      'crates/cli/src/main.rs',
    )
  })

  it('handles foo/mod.rs layout with super:: and self::', () => {
    const root = tmpRoot()
    const fileSet = new Set([
      'crates/core/src/lib.rs',
      'crates/core/src/cards/mod.rs',
      'crates/core/src/cards/deck.rs',
    ])
    const decls = new Map([
      ['crates/core/src/lib.rs', ['cards']],
      ['crates/core/src/cards/mod.rs', ['deck']],
    ])
    const ctx = buildResolverContext(
      root,
      fileSet,
      [pkg(0, 'fix-core', 'crates/core', 'cargo')],
      decls,
    )
    expect(ctx.rustMods.get('crates/core/src/cards/mod.rs')).toBe('fix_core::cards')
    expect(ctx.rustMods.get('crates/core/src/cards/deck.rs')).toBe('fix_core::cards::deck')
    expect(resolveImport('crates/core/src/cards/deck.rs', 'super::shuffle', ctx)).toBe(
      'crates/core/src/cards/mod.rs',
    )
    expect(resolveImport('crates/core/src/cards/mod.rs', 'self::deck::Deck', ctx)).toBe(
      'crates/core/src/cards/deck.rs',
    )
    expect(resolveImport('crates/core/src/cards/deck.rs', 'super::super::lib_item', ctx)).toBe(
      'crates/core/src/lib.rs',
    )
  })

  it('returns null for std and unknown crates', () => {
    const root = tmpRoot()
    const fileSet = new Set(['src/lib.rs'])
    const ctx = buildResolverContext(root, fileSet, [pkg(0, 'fix-core', '', 'cargo')], new Map())
    expect(resolveImport('src/lib.rs', 'std::collections::HashMap', ctx)).toBeNull()
    expect(resolveImport('src/lib.rs', 'serde::Serialize', ctx)).toBeNull()
  })
})

describe('graph', () => {
  it('builds fwd/rev/centrality, skipping self-edges, sorted', () => {
    const g = buildGraph(
      new Map([
        ['b.ts', new Set(['c.ts'])],
        ['a.ts', new Set(['c.ts', 'b.ts', 'a.ts'])],
        ['d.ts', new Set(['d.ts'])],
      ]),
    )
    expect(g.fwd['a.ts']).toEqual(['b.ts', 'c.ts'])
    expect(g.fwd['d.ts']).toBeUndefined()
    expect(g.rev['c.ts']).toEqual(['a.ts', 'b.ts'])
    expect(g.centrality['c.ts']).toBe(2)
    expect(g.centrality['b.ts']).toBe(1)
    expect(Object.keys(g.fwd)).toEqual(['a.ts', 'b.ts'])
  })

  it('finds shortest paths deterministically', () => {
    const g = buildGraph(
      new Map([
        ['a', new Set(['c', 'b'])],
        ['b', new Set(['d'])],
        ['c', new Set(['d'])],
        ['d', new Set(['e'])],
      ]),
    )
    expect(shortestPaths(g, 'a', 'd')).toEqual([
      ['a', 'b', 'd'],
      ['a', 'c', 'd'],
    ])
    expect(shortestPaths(g, 'a', 'd', 1)).toEqual([['a', 'b', 'd']])
    expect(shortestPaths(g, 'a', 'e')).toEqual([
      ['a', 'b', 'd', 'e'],
      ['a', 'c', 'd', 'e'],
    ])
    expect(shortestPaths(g, 'e', 'a')).toEqual([])
    expect(shortestPaths(g, 'a', 'a')).toEqual([['a']])
  })
})
