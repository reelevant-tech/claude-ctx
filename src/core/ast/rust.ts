import type { CallRef, ParsedSymbol, ParseResult, SymbolKind, SymbolNode } from '../types'
import { getParser } from './loader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any

export interface RustExtract {
  result: ParseResult
  tree: SymbolNode[]
  calls: CallRef[]
}

const ITEM_KIND: Record<string, SymbolKind> = {
  function_item: 'fn',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  impl_item: 'impl',
  mod_item: 'mod',
  type_item: 'type',
  const_item: 'const',
  static_item: 'const',
  union_item: 'struct',
  macro_definition: 'macro',
}

const line = (n: Node): number => n.startPosition.row + 1
const endLine = (n: Node): number => n.endPosition.row + 1
const sigOf = (n: Node): string => {
  const first = String(n.text).split('\n')[0]!.trim()
  return first.length > 120 ? first.slice(0, 120) : first
}
const isPub = (n: Node): boolean => {
  for (let i = 0; i < n.childCount; i++) if (n.child(i)?.type === 'visibility_modifier') return true
  return false
}

function nameOf(n: Node): string {
  if (n.type === 'impl_item') {
    const trait = n.childForFieldName('trait')
    const type = n.childForFieldName('type')
    const t = type ? String(type.text) : ''
    return trait ? `${String(trait.text)} for ${t}` : t
  }
  const name = n.childForFieldName('name')
  return name ? String(name.text) : ''
}

/** Last identifier of a callee node: `foo`, `obj.bar` -> bar, `T::assoc` -> assoc. */
function calleeName(fn: Node): string | null {
  if (!fn) return null
  if (fn.type === 'identifier' || fn.type === 'field_identifier') return String(fn.text)
  if (fn.type === 'field_expression') {
    const f = fn.childForFieldName('field')
    return f ? String(f.text) : null
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name')
    return name ? String(name.text) : null
  }
  const t = String(fn.text)
  const m = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)
  return m ? m[1]! : null
}

function useBase(argText: string): string {
  let s = argText.trim()
  const brace = s.indexOf('{')
  if (brace !== -1) s = s.slice(0, brace)
  s = s.replace(/::\s*\*\s*$/, '')
  s = (s.split(/\s+as\s+/)[0] ?? s).replace(/::\s*$/, '').replace(/;\s*$/, '').trim()
  return s
}

export async function extractRust(source: string): Promise<RustExtract | null> {
  const parser = await getParser('rust')
  if (!parser) return null
  let root: Node
  try {
    root = parser.parse(source).rootNode
  } catch {
    return null
  }

  const symbols: ParsedSymbol[] = []
  const imports: string[] = []
  const exportsSet = new Set<string>()
  const modDecls: string[] = []
  const hasCfgTest = source.includes('#[cfg(test)]')

  // imports: walk all use_declarations
  const collectUses = (n: Node): void => {
    if (n.type === 'use_declaration') {
      const arg = n.childForFieldName('argument')
      if (arg) {
        const base = useBase(String(arg.text))
        if (base) imports.push(base)
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) collectUses(n.namedChild(i))
  }
  collectUses(root)

  // symbol tree + flat symbols. Recurse only into mod/impl/trait bodies.
  const body = (n: Node): Node | null => {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)
      if (c?.type === 'declaration_list') return c
    }
    return null
  }

  const buildItems = (container: Node, modPath: string[], implType: string | undefined, pubChain: boolean): SymbolNode[] => {
    const out: SymbolNode[] = []
    for (let i = 0; i < container.namedChildCount; i++) {
      const n = container.namedChild(i)
      const k = ITEM_KIND[n.type]
      if (!k) continue
      const name = nameOf(n)
      const pub = isPub(n) || n.type === 'macro_definition' ? isPub(n) || hasMacroExport(n) : isPub(n)
      const m = [...modPath, ...(implType ? [implType] : [])].join('::')

      // flat symbol (compatible with the regex parser: k 'fn' for methods too)
      const sym: ParsedSymbol = { n: name, k, l: line(n), x: pub, sig: sigOf(n) }
      if (m) sym.m = m
      symbols.push(sym)
      if (pub && pubChain && name) exportsSet.add(name)

      const node: SymbolNode = {
        n: name,
        k: implType && k === 'fn' ? 'method' : k,
        l: line(n),
        endL: endLine(n),
        x: pub,
        sig: sigOf(n),
      }

      // mod foo; (no body) => declaration only
      if (n.type === 'mod_item') {
        const b = body(n)
        if (!b) {
          modDecls.push(name)
        } else {
          const kids = buildItems(b, [...modPath, name], undefined, pubChain && pub)
          if (kids.length > 0) node.children = kids
        }
      } else if (n.type === 'impl_item' || n.type === 'trait_item') {
        const b = body(n)
        if (b) {
          const implName = n.type === 'impl_item' ? (n.childForFieldName('type')?.text ?? name) : name
          const kids = buildItems(b, modPath, String(implName), pubChain && pub)
          if (kids.length > 0) node.children = kids
        }
      }
      out.push(node)
    }
    return out
  }

  const tree = buildItems(root, [], undefined, true)

  // calls: walk everything, tracking enclosing function name
  const calls: CallRef[] = []
  const collectCalls = (n: Node, caller: string | undefined): void => {
    let nextCaller = caller
    if (n.type === 'function_item') {
      const nm = n.childForFieldName('name')
      nextCaller = nm ? String(nm.text) : caller
    }
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function')
      const callee = calleeName(fn)
      if (callee) calls.push(caller ? { callee, line: line(n), caller } : { callee, line: line(n) })
    }
    for (let i = 0; i < n.namedChildCount; i++) collectCalls(n.namedChild(i), nextCaller)
  }
  collectCalls(root, undefined)

  return {
    result: { symbols, imports, exports: [...exportsSet], docHeadings: [], modDecls, hasCfgTest },
    tree,
    calls,
  }
}

/** #[macro_export] on a preceding attribute sibling. */
function hasMacroExport(n: Node): boolean {
  let prev = n.previousSibling
  while (prev) {
    if (prev.type === 'attribute_item') {
      if (String(prev.text).includes('macro_export')) return true
    } else if (prev.type !== 'line_comment' && prev.type !== 'block_comment') {
      break
    }
    prev = prev.previousSibling
  }
  return false
}
