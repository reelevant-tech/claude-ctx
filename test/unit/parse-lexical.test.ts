import { describe, it, expect } from 'vitest'
import { parseLexical } from '../../src/core/indexer/parse-lexical'
import type { ParsedSymbol } from '../../src/core/types'

function sym(symbols: ParsedSymbol[], n: string): ParsedSymbol {
  const s = symbols.find((x) => x.n === n)
  if (s === undefined) throw new Error(`symbol not found: ${n}`)
  return s
}

describe('parseLexical ts/js', () => {
  const src = [
    "import { x } from './x'", // 1
    "const c = require('cjs')", // 2
    "export * from './re'", // 3
    'export function foo(a: string) {', // 4
    '}', // 5
    'export class Bar {}', // 6
    'export interface Baz {}', // 7
    'export type T = string', // 8
    'export enum E {}', // 9
    'export const K = 1', // 10
    'export let L = 2', // 11
    'function plainFn() {}', // 12
    'class PlainClass {}', // 13
    'const notCollected = 5', // 14
    'export default function main() {}', // 15
  ].join('\n')
  const r = parseLexical(src, 'ts')

  it('collects imports from import/require/export-from lines', () => {
    expect(r.imports).toEqual(['./x', 'cjs', './re'])
  })

  it('collects exported declarations of every kind with correct k/l/x', () => {
    expect(sym(r.symbols, 'foo')).toMatchObject({ k: 'fn', l: 4, x: true })
    expect(sym(r.symbols, 'Bar')).toMatchObject({ k: 'class', l: 6, x: true })
    expect(sym(r.symbols, 'Baz')).toMatchObject({ k: 'iface', l: 7, x: true })
    expect(sym(r.symbols, 'T')).toMatchObject({ k: 'type', l: 8, x: true })
    expect(sym(r.symbols, 'E')).toMatchObject({ k: 'enum', l: 9, x: true })
    expect(sym(r.symbols, 'K')).toMatchObject({ k: 'const', l: 10, x: true })
    expect(sym(r.symbols, 'L')).toMatchObject({ k: 'var', l: 11, x: true })
  })

  it('collects non-exported function/class but not non-exported const', () => {
    expect(sym(r.symbols, 'plainFn')).toMatchObject({ k: 'fn', l: 12, x: false })
    expect(sym(r.symbols, 'PlainClass')).toMatchObject({ k: 'class', l: 13, x: false })
    expect(r.symbols.find((s) => s.n === 'notCollected')).toBeUndefined()
  })

  it('exports are the x=true names plus default', () => {
    expect(r.exports).toEqual(['foo', 'Bar', 'Baz', 'T', 'E', 'K', 'L', 'default', 'main'])
  })

  it('sig is the trimmed matched line, truncated to 120; docHeadings empty', () => {
    expect(sym(r.symbols, 'foo').sig).toBe('export function foo(a: string) {')
    expect(r.docHeadings).toEqual([])
    const long = parseLexical(`export const LONG = '${'z'.repeat(300)}'`, 'js')
    expect(sym(long.symbols, 'LONG').sig.length).toBe(120)
  })
})

describe('parseLexical md', () => {
  it('extracts h1-h3 headings, capped at 10, ignores h4+', () => {
    const lines = ['#### too deep', '#nospace']
    for (let i = 1; i <= 12; i++) lines.push(`${'#'.repeat(((i - 1) % 3) + 1)} Heading ${i}`)
    const r = parseLexical(lines.join('\n'), 'md')
    expect(r.docHeadings.length).toBe(10)
    expect(r.docHeadings[0]).toBe('Heading 1')
    expect(r.docHeadings[9]).toBe('Heading 10')
    expect(r.docHeadings).not.toContain('too deep')
    expect(r.symbols).toEqual([])
    expect(r.imports).toEqual([])
    expect(r.exports).toEqual([])
  })
})

describe('parseLexical other langs', () => {
  it('returns an all-empty result', () => {
    const r = parseLexical('fn main() { println!("hi"); }', 'rust')
    expect(r).toEqual({ symbols: [], imports: [], exports: [], docHeadings: [] })
  })
})
