import type { CallRef, SymbolNode } from '../types'

/** Indented nested symbol tree, e.g. `struct Deck [L1-3]` / `  method shuffle [L2]`. */
export function renderSymbolTree(nodes: SymbolNode[], indent = 0): string {
  const lines: string[] = []
  for (const n of nodes) {
    const vis = n.x ? '' : ' (private)'
    const span = n.endL > n.l ? `L${n.l}-${n.endL}` : `L${n.l}`
    lines.push(`${'  '.repeat(indent)}${n.k} ${n.n}${vis}  [${span}]`)
    if (n.children && n.children.length > 0) lines.push(renderSymbolTree(n.children, indent + 1))
  }
  return lines.join('\n')
}

/** Calls grouped by their enclosing symbol. */
export function renderCalls(calls: CallRef[]): string {
  if (calls.length === 0) return '(no call expressions found)'
  const byCaller = new Map<string, CallRef[]>()
  for (const c of calls) {
    const key = c.caller ?? '(top level)'
    const arr = byCaller.get(key) ?? []
    arr.push(c)
    byCaller.set(key, arr)
  }
  const lines: string[] = []
  for (const caller of [...byCaller.keys()].sort()) {
    lines.push(`${caller}:`)
    for (const c of byCaller.get(caller)!) lines.push(`  → ${c.callee}() [L${c.line}]`)
  }
  return lines.join('\n')
}
