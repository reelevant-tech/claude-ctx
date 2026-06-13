import type { CallRef, ParsedSymbol, ParseResult, SymbolKind, SymbolNode } from '../types'
import { getParser } from './loader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any

export interface PythonExtract {
  result: ParseResult
  tree: SymbolNode[]
  calls: CallRef[]
}

const line = (n: Node): number => (n.startPosition.row as number) + 1
const endLine = (n: Node): number => (n.endPosition.row as number) + 1
const sigOf = (n: Node): string => {
  const first = String(n.text).split('\n')[0]!.trim()
  return first.length > 120 ? first.slice(0, 120) : first
}
const isPub = (name: string): boolean => !name.startsWith('_')

/** Unwrap a decorated_definition to its inner function_definition or class_definition. */
function innerDef(n: Node): Node {
  if (n.type === 'decorated_definition') {
    return n.childForFieldName('definition') ?? n
  }
  return n
}

function nameOf(n: Node): string {
  const inner = innerDef(n)
  const name = inner.childForFieldName('name')
  return name ? String(name.text) : ''
}

function calleeName(fn: Node): string | null {
  if (!fn) return null
  if (fn.type === 'identifier') return String(fn.text)
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute')
    return attr ? String(attr.text) : null
  }
  const t = String(fn.text)
  const m = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)
  return m ? (m[1] ?? null) : null
}

function collectImports(root: Node, imports: string[]): void {
  const seen = new Set<string>()
  const add = (s: string): void => {
    if (s && !seen.has(s)) {
      seen.add(s)
      imports.push(s)
    }
  }

  const walk = (n: Node): void => {
    if (n.type === 'import_statement') {
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i)
        if (!child) continue
        const name = child.type === 'aliased_import' ? child.childForFieldName('name') : child
        if (name) add((String(name.text).split('.')[0]) ?? '')
      }
    } else if (n.type === 'import_from_statement') {
      const mod = n.childForFieldName('module_name')
      if (mod) add((String(mod.text).split('.')[0]) ?? '')
    } else {
      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i))
    }
  }
  walk(root)
}

function buildItems(container: Node, insideClass: boolean, symbols: ParsedSymbol[]): SymbolNode[] {
  const out: SymbolNode[] = []

  for (let i = 0; i < container.namedChildCount; i++) {
    const raw = container.namedChild(i)
    const n = innerDef(raw)

    let k: SymbolKind
    if (n.type === 'function_definition') {
      k = insideClass ? 'method' : 'fn'
    } else if (n.type === 'class_definition') {
      k = 'class'
    } else {
      continue
    }

    const name = nameOf(raw)
    if (!name) continue
    const pub = isPub(name)

    symbols.push({ n: name, k, l: line(raw), x: pub, sig: sigOf(raw) })

    const node: SymbolNode = {
      n: name,
      k,
      l: line(raw),
      endL: endLine(raw),
      x: pub,
      sig: sigOf(raw),
    }

    if (k === 'class') {
      const body = n.childForFieldName('body')
      if (body) {
        const kids = buildItems(body, true, symbols)
        if (kids.length > 0) node.children = kids
      }
    }

    out.push(node)
  }

  return out
}

function collectCalls(root: Node, calls: CallRef[]): void {
  const walk = (n: Node, caller: string | undefined): void => {
    let nextCaller = caller
    if (n.type === 'function_definition') {
      const nm = n.childForFieldName('name')
      nextCaller = nm ? String(nm.text) : caller
    }
    if (n.type === 'call') {
      const fn = n.childForFieldName('function')
      const callee = calleeName(fn)
      if (callee) calls.push(caller ? { callee, line: line(n), caller } : { callee, line: line(n) })
    }
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i), nextCaller)
  }
  walk(root, undefined)
}

export async function extractPython(source: string): Promise<PythonExtract | null> {
  const parser = await getParser('python')
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

  // detect explicit __all__ = [...] at module level
  for (let i = 0; i < root.namedChildCount; i++) {
    const n = root.namedChild(i)
    if (n?.type !== 'expression_statement') continue
    const assign = n.namedChild(0)
    if (assign?.type !== 'assignment') continue
    const left = assign.childForFieldName('left')
    const right = assign.childForFieldName('right')
    if (!left || String(left.text) !== '__all__' || !right) continue
    if (right.type === 'list' || right.type === 'tuple') {
      for (let j = 0; j < right.namedChildCount; j++) {
        const el = right.namedChild(j)
        if (el?.type === 'string') {
          const txt = String(el.text).replace(/^[bBfFrRuU]*['"]+|['"]+$/g, '')
          if (txt) exportsSet.add(txt)
        }
      }
    }
  }

  collectImports(root, imports)
  const tree = buildItems(root, false, symbols)

  // fall back to all top-level public symbols when no __all__
  if (exportsSet.size === 0) {
    for (const sym of symbols) {
      if (sym.x && sym.k !== 'method') exportsSet.add(sym.n)
    }
  }

  const calls: CallRef[] = []
  collectCalls(root, calls)

  return {
    result: {
      symbols,
      imports,
      exports: [...exportsSet],
      docHeadings: [],
      modDecls: [],
      hasCfgTest: false,
    },
    tree,
    calls,
  }
}
