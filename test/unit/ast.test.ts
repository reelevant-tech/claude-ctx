import { describe, expect, it } from 'vitest'
import { extractRust } from '../../src/core/ast/rust'
import { extractTsTree } from '../../src/core/ast/ts-tree'
import { renderSymbolTree } from '../../src/core/ast/render'
import { findReferences } from '../../src/cli/commands/references'
import type { CallsShard } from '../../src/core/types'

describe('extractRust (tree-sitter)', () => {
  const SRC = `use crate::Engine;
pub struct Deck { cards: Vec<u8> }
impl Deck {
  pub fn shuffle(&mut self, seed: u64) -> u32 { evaluate_hand(&self.cards) }
  fn private_helper(&self) {}
}
pub trait Scorer { fn score(&self) -> u32; }
pub fn evaluate(input: &str) -> u32 { parse(input) }
mod submod;
#[cfg(test)] mod tests { #[test] fn t() { evaluate("x"); } }`

  it('builds a nested tree with impl methods and detects pub/cfg(test)', async () => {
    const rx = await extractRust(SRC)
    expect(rx).not.toBeNull()
    const { result, tree, calls } = rx!
    // flat ParseResult stays compatible
    expect(result.exports).toContain('Deck')
    expect(result.exports).toContain('evaluate')
    expect(result.imports).toContain('crate::Engine')
    expect(result.modDecls).toContain('submod')
    expect(result.hasCfgTest).toBe(true)
    // nested tree: impl Deck > method shuffle
    const impl = tree.find((n) => n.k === 'impl' && n.n.includes('Deck'))
    expect(impl).toBeTruthy()
    expect(impl!.children?.some((c) => c.k === 'method' && c.n === 'shuffle' && c.x)).toBe(true)
    expect(impl!.children?.some((c) => c.n === 'private_helper' && !c.x)).toBe(true)
    // calls captured with enclosing caller
    expect(calls.some((c) => c.callee === 'evaluate_hand' && c.caller === 'shuffle')).toBe(true)
  })

  it('renders the tree indented', async () => {
    const rx = await extractRust(SRC)
    const rendered = renderSymbolTree(rx!.tree)
    expect(rendered).toContain('struct Deck')
    expect(rendered).toMatch(/method shuffle/)
  })
})

describe('extractTsTree (TS compiler AST)', () => {
  const SRC = `import { z } from 'zod'
export class Billing {
  createInvoice(c: string): string { return format(c) }
  private secret() {}
}
export function main() { new Billing().createInvoice('x') }
export const VERSION = '1'`

  it('builds class members as nested methods with visibility', () => {
    const { tree, calls } = extractTsTree(SRC, 'billing.ts')
    const cls = tree.find((n) => n.k === 'class' && n.n === 'Billing')
    expect(cls).toBeTruthy()
    expect(cls!.children?.some((c) => c.k === 'method' && c.n === 'createInvoice' && c.x)).toBe(true)
    expect(cls!.children?.some((c) => c.n === 'secret' && !c.x)).toBe(true)
    expect(tree.some((n) => n.k === 'fn' && n.n === 'main' && n.x)).toBe(true)
    expect(tree.some((n) => n.k === 'const' && n.n === 'VERSION')).toBe(true)
    // calls track the enclosing function/method
    expect(calls.some((c) => c.callee === 'createInvoice' && c.caller === 'main')).toBe(true)
    expect(calls.some((c) => c.callee === 'format' && c.caller === 'createInvoice')).toBe(true)
  })

  it('extracts field accesses tagged read/write/destructure with the enclosing function', () => {
    const src = `function f(o: any) {
  const a = o.alpha
  o.beta = 1
  const obj = { gamma: a }
  const { delta } = o
  return obj.gamma
}`
    const { fields } = extractTsTree(src, 'f.ts')
    const has = (field: string, kind: string) =>
      fields.some((x) => x.field === field && x.kind === kind && x.caller === 'f')
    expect(has('alpha', 'read')).toBe(true)
    expect(has('beta', 'write')).toBe(true)
    expect(has('gamma', 'write')).toBe(true) // { gamma: a } object-literal key
    expect(has('delta', 'destructure')).toBe(true)
    expect(has('gamma', 'read')).toBe(true) // obj.gamma
  })
})

describe('findReferences', () => {
  it('finds name-based call sites across files', () => {
    const shard: CallsShard = {
      calls: {
        'a.ts': [{ callee: 'foo', line: 3, caller: 'main' }, { callee: 'bar', line: 5 }],
        'b.ts': [{ callee: 'foo', line: 9, caller: 'run' }],
      },
    }
    const refs = findReferences(shard, 'foo')
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ file: 'a.ts', line: 3, caller: 'main' })
    expect(refs[1]).toEqual({ file: 'b.ts', line: 9, caller: 'run' })
    expect(findReferences(shard, 'nonexistent')).toHaveLength(0)
  })
})
