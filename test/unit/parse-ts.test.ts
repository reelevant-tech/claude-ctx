import { describe, it, expect } from 'vitest'
import { parseTs } from '../../src/core/indexer/parse-ts'
import type { ParsedSymbol } from '../../src/core/types'

function sym(symbols: ParsedSymbol[], n: string): ParsedSymbol {
  const s = symbols.find((x) => x.n === n)
  if (s === undefined) throw new Error(`symbol not found: ${n}`)
  return s
}

describe('parseTs imports', () => {
  it('collects default/named/namespace imports, import=, top-level require and dynamic import', () => {
    const src = [
      "import def from './def'",
      "import { named } from 'pkg'",
      "import * as ns from 'node:path'",
      "import eq = require('legacy')",
      "const lazy = require('cjs-dep')",
      "const dyn = import('dyn-dep')",
    ].join('\n')
    const r = parseTs(src, 'a.ts')
    expect(r.imports).toEqual(['./def', 'pkg', 'node:path', 'legacy', 'cjs-dep', 'dyn-dep'])
  })

  it('skips computed/non-literal specifiers', () => {
    const r = parseTs("const x = require(someVar)\nconst y = require('real')", 'a.ts')
    expect(r.imports).toEqual(['real'])
  })

  it('collects require inside destructuring initializer but skips pattern names', () => {
    const r = parseTs("const { d1, d2 } = require('thing')", 'a.ts')
    expect(r.imports).toEqual(['thing'])
    expect(r.symbols).toEqual([])
  })
})

describe('parseTs symbols and exports', () => {
  const src = [
    'export function fn1(a: number): string {', // 1
    "  return 'x'", // 2
    '}', // 3
    'export class Klass {}', // 4
    'export interface Iface {', // 5
    '  x: number', // 6
    '}', // 7
    'export type Alias = string | number', // 8
    'export enum Color {', // 9
    '  Red,', // 10
    '}', // 11
    'export const C1 = 1', // 12
    'const hidden = 2', // 13
    'let mutable = 3', // 14
    'function plain() {}', // 15
    'export { hidden as renamed }', // 16
    "export { helper } from './util'", // 17
    'export default function main() {}', // 18
  ].join('\n')
  const r = parseTs(src, 'mod.ts')

  it('maps declaration kinds with correct lines and export flags', () => {
    expect(sym(r.symbols, 'fn1')).toMatchObject({ k: 'fn', l: 1, x: true })
    expect(sym(r.symbols, 'Klass')).toMatchObject({ k: 'class', l: 4, x: true })
    expect(sym(r.symbols, 'Iface')).toMatchObject({ k: 'iface', l: 5, x: true })
    expect(sym(r.symbols, 'Alias')).toMatchObject({ k: 'type', l: 8, x: true })
    expect(sym(r.symbols, 'Color')).toMatchObject({ k: 'enum', l: 9, x: true })
    expect(sym(r.symbols, 'C1')).toMatchObject({ k: 'const', l: 12, x: true })
    expect(sym(r.symbols, 'main')).toMatchObject({ k: 'fn', l: 18, x: true })
  })

  it('sig is the first line of the declaration, trimmed', () => {
    expect(sym(r.symbols, 'fn1').sig).toBe('export function fn1(a: number): string {')
    expect(sym(r.symbols, 'Iface').sig).toBe('export interface Iface {')
  })

  it('non-exported symbols have x=false', () => {
    expect(sym(r.symbols, 'mutable')).toMatchObject({ k: 'var', x: false })
    expect(sym(r.symbols, 'plain')).toMatchObject({ k: 'fn', x: false })
  })

  it('marks symbols x=true when exported via a later export statement', () => {
    expect(sym(r.symbols, 'hidden')).toMatchObject({ k: 'const', l: 13, x: true })
  })

  it('exports list includes modifier exports, renamed names, re-exports and default', () => {
    expect(r.exports).toEqual([
      'fn1',
      'Klass',
      'Iface',
      'Alias',
      'Color',
      'C1',
      'renamed',
      'helper',
      'default',
    ])
  })

  it('re-export module specifier counts as an import; docHeadings always empty', () => {
    expect(r.imports).toEqual(['./util'])
    expect(r.docHeadings).toEqual([])
  })
})

describe('parseTs edge cases', () => {
  it('handles export assignment / export default expression', () => {
    const r = parseTs('const v = 1\nexport default v', 'a.ts')
    expect(r.exports).toContain('default')
  })

  it('handles export * from as import only', () => {
    const r = parseTs("export * from './everything'", 'a.ts')
    expect(r.imports).toEqual(['./everything'])
    expect(r.exports).toEqual([])
  })

  it('emits one symbol per declarator with per-declarator lines', () => {
    const r = parseTs('const a = 1,\n  b = 2', 'a.ts')
    expect(r.symbols.map((s) => [s.n, s.k, s.l, s.x])).toEqual([
      ['a', 'const', 1, false],
      ['b', 'const', 2, false],
    ])
  })

  it('truncates sig to 120 chars', () => {
    const r = parseTs(`export const LONG = '${'a'.repeat(300)}'`, 'a.ts')
    const s = sym(r.symbols, 'LONG')
    expect(s.sig.length).toBe(120)
    expect(s.sig.startsWith('export const LONG =')).toBe(true)
  })

  it('parses JSX in .tsx files', () => {
    const src = 'export function App() {\n  return <div className="x">hi</div>\n}'
    const r = parseTs(src, 'App.tsx')
    expect(sym(r.symbols, 'App')).toMatchObject({ k: 'fn', l: 1, x: true })
    expect(r.exports).toEqual(['App'])
  })

  it('throws on files above the size cap', () => {
    expect(() => parseTs('x'.repeat(1_500_001), 'big.ts')).toThrow('file too large')
  })

  it('does not throw on weird-but-parseable code', () => {
    const r = parseTs('export const = \nfunction (((\nclass {', 'broken.ts')
    expect(Array.isArray(r.symbols)).toBe(true)
  })
})
