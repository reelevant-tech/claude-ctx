import { describe, it, expect } from 'vitest'
import { parseRust } from '../../src/core/indexer/parse-rust'
import type { ParsedSymbol } from '../../src/core/types'

const FIXTURE = `use std::collections::HashMap;
use crate::foo::{a, b};
use a::b as c;
pub use x::y;

mod decl_only;

pub fn top_fn(x: u32) -> u32 {
    let s = "}}}{";
    x
}

fn private_fn() {}

pub struct Point {
    x: f64,
}

pub enum Color {
    Red,
    Green,
}

pub trait Shape {
    fn area(&self) -> f64;
}

pub type Alias = Vec<u8>;
pub const MAX: u32 = 10;
pub static GREETING: &str = "hi {";
pub union Bits {
    i: i32,
}

mod helpers {
    pub fn helper_fn() -> u32 {
        1
    }
}

impl Point {
    pub fn new() -> Self {
        Point { x: 0.0 }
    }
    fn secret(&self) {}
}

impl Display for Point {
    fn fmt(&self, f: &mut Formatter) -> Result {
        write!(f, "{}", self.x)
    }
}

#[macro_export]
macro_rules! exported_macro {
    () => {};
}

macro_rules! private_macro {
    () => {};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        assert_eq!(top_fn(1), 1);
    }
}
`

const res = parseRust(FIXTURE)
const sym = (n: string): ParsedSymbol | undefined => res.symbols.find((s) => s.n === n)
const lineOf = (snippet: string): number =>
  FIXTURE.split('\n').findIndex((l) => l.includes(snippet)) + 1

describe('parseRust items', () => {
  it('records pub items with correct kinds', () => {
    expect(sym('top_fn')?.k).toBe('fn')
    expect(sym('Point')?.k).toBe('struct')
    expect(sym('Color')?.k).toBe('enum')
    expect(sym('Shape')?.k).toBe('trait')
    expect(sym('Alias')?.k).toBe('type')
    expect(sym('MAX')?.k).toBe('const')
    expect(sym('GREETING')?.k).toBe('const')
    expect(sym('Bits')?.k).toBe('struct')
  })

  it('marks pub vs non-pub via x', () => {
    expect(sym('top_fn')?.x).toBe(true)
    expect(sym('private_fn')?.x).toBe(false)
  })

  it('builds exports from pub items at exportable levels only', () => {
    for (const n of ['top_fn', 'Point', 'Color', 'Shape', 'Alias', 'MAX', 'GREETING', 'Bits']) {
      expect(res.exports).toContain(n)
    }
    expect(res.exports).not.toContain('private_fn')
    expect(res.exports).not.toContain('helper_fn')
    expect(res.exports).not.toContain('helpers')
    expect(res.exports).not.toContain('new')
  })

  it('records mod blocks and nested items with module path', () => {
    expect(sym('helpers')?.k).toBe('mod')
    expect(sym('helper_fn')?.m).toBe('helpers')
    expect(sym('helper_fn')?.x).toBe(true)
  })

  it('omits m at file top level', () => {
    const s = sym('top_fn')
    expect(s).toBeDefined()
    expect(s !== undefined && 'm' in s).toBe(false)
  })

  it('handles mod foo; semicolon form', () => {
    expect(res.modDecls).toEqual(['decl_only'])
    expect(sym('decl_only')?.k).toBe('mod')
  })

  it('captures #[cfg(test)] mod tests and hasCfgTest', () => {
    expect(res.hasCfgTest).toBe(true)
    expect(sym('tests')?.k).toBe('mod')
    expect(sym('it_works')?.m).toBe('tests')
    expect(parseRust('pub fn a() {}').hasCfgTest).toBe(false)
  })

  it('records impl blocks and pub methods inside them', () => {
    const impls = res.symbols.filter((s) => s.k === 'impl').map((s) => s.n)
    expect(impls).toEqual(['Point', 'Display for Point'])
    expect(sym('new')?.k).toBe('fn')
    expect(sym('new')?.m).toBe('Point')
    expect(sym('new')?.x).toBe(true)
    expect(sym('secret')).toBeUndefined()
    expect(sym('fmt')).toBeUndefined()
  })

  it('records macro_rules with macro_export detection', () => {
    expect(sym('exported_macro')?.k).toBe('macro')
    expect(sym('exported_macro')?.x).toBe(true)
    expect(sym('private_macro')?.k).toBe('macro')
    expect(sym('private_macro')?.x).toBe(false)
  })

  it('parses use statements to base paths', () => {
    expect(res.imports).toEqual(['std::collections::HashMap', 'crate::foo', 'a::b', 'x::y', 'super'])
  })

  it('reports correct 1-based line numbers and sig', () => {
    expect(sym('top_fn')?.l).toBe(lineOf('pub fn top_fn'))
    expect(sym('Point')?.l).toBe(lineOf('pub struct Point'))
    expect(res.symbols.find((s) => s.n === 'Display for Point')?.l).toBe(lineOf('impl Display'))
    expect(sym('top_fn')?.sig).toBe('pub fn top_fn(x: u32) -> u32 {')
  })
})

describe('parseRust lexer robustness', () => {
  it('ignores braces inside line and nested block comments', () => {
    const src = `// fn commented() {
/* { */
/* nested /* } */ still */
pub fn real() {} // }
pub fn after() {}
`
    const r = parseRust(src)
    expect(r.symbols.map((s) => s.n)).toEqual(['real', 'after'])
    expect(r.symbols[0]?.l).toBe(4)
    expect(r.symbols[1]?.l).toBe(5)
  })

  it('ignores braces inside raw strings r#"{"#', () => {
    const src = `pub fn raw() -> &'static str {
    r#"{"key": "}"}"#
}
pub fn after_raw() {}
`
    const r = parseRust(src)
    expect(r.symbols.map((s) => s.n)).toEqual(['raw', 'after_raw'])
    expect(r.exports).toEqual(['raw', 'after_raw'])
    expect(r.symbols[1]?.m).toBeUndefined()
  })

  it('ignores braces inside char literals and escapes', () => {
    const src = `pub fn chars() {
    let a = '{';
    let b = '\\'';
    let c = '}';
    let d = '\\u{1F600}';
}
pub fn after_chars() {}
`
    const r = parseRust(src)
    expect(r.symbols.map((s) => s.n)).toEqual(['chars', 'after_chars'])
  })

  it('handles multi-line fn signatures with correct start line', () => {
    const src = `pub fn multi(
    a: u32,
    b: u32,
) -> u32 {
    a + b
}
`
    const r = parseRust(src)
    expect(r.symbols[0]?.n).toBe('multi')
    expect(r.symbols[0]?.l).toBe(1)
  })

  it('truncates sig to 120 chars', () => {
    const long = `pub fn ${'x'.repeat(150)}() {}`
    const r = parseRust(long)
    expect(r.symbols[0]?.sig.length).toBe(120)
  })
})

describe('parseRust edge forms', () => {
  it('strips generics from impl names and uses type for method m', () => {
    const src = `impl<T: Clone> Wrapper<T> {
    pub fn get(&self) -> T {
        self.0
    }
}
`
    const r = parseRust(src)
    expect(r.symbols[0]?.n).toBe('Wrapper')
    expect(r.symbols[1]?.n).toBe('get')
    expect(r.symbols[1]?.m).toBe('Wrapper')
  })

  it('handles static mut, pub(crate), const fn and async fn', () => {
    const src = `pub static mut COUNT: u32 = 0;
pub(crate) fn scoped() {}
pub const fn cfn() -> u32 { 1 }
pub async fn afn() {}
`
    const r = parseRust(src)
    expect(sym2(r.symbols, 'COUNT')?.k).toBe('const')
    expect(sym2(r.symbols, 'scoped')?.x).toBe(true)
    expect(sym2(r.symbols, 'cfn')?.k).toBe('fn')
    expect(sym2(r.symbols, 'afn')?.k).toBe('fn')
  })

  it('exports pub items nested in pub mods but not in private mods', () => {
    const src = `pub mod open {
    pub fn visible() {}
}
mod closed {
    pub fn hidden() {}
}
`
    const r = parseRust(src)
    expect(r.exports).toContain('visible')
    expect(r.exports).not.toContain('hidden')
    expect(sym2(r.symbols, 'hidden')?.m).toBe('closed')
  })

  it('parses a 5000-line file in under 50ms', () => {
    let big = ''
    for (let i = 0; i < 270; i++) {
      big += `pub fn func_${i}(x: u32) -> u32 {\n    let s = "{} // }";\n    x + ${i}\n}\n\npub struct Struct_${i} {\n    field: u32,\n}\n\nimpl Struct_${i} {\n    pub fn get_${i}(&self) -> u32 {\n        self.field\n    }\n}\n\nmod mod_${i} {\n    pub fn inner_${i}() {}\n}\n\n`
    }
    expect(big.split('\n').length).toBeGreaterThanOrEqual(5000)
    parseRust(big) // warm-up
    const t0 = performance.now()
    const r = parseRust(big)
    const elapsed = performance.now() - t0
    expect(r.symbols.length).toBe(1620)
    expect(elapsed).toBeLessThan(50)
  })
})

function sym2(symbols: ParsedSymbol[], n: string): ParsedSymbol | undefined {
  return symbols.find((s) => s.n === n)
}
