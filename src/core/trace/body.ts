import { searchSymbols } from '../../cli/commands/symbols'
import { rangeSnippet } from '../ast/snippet'
import { pickDefinition } from '../ast/ts-refs'
import { redactSecrets } from '../guard/redact'
import { loadShard } from '../store/shards'
import type { LoadedIndex, SymbolNode, SymbolRecord, SymbolTreeShard } from '../types'

export interface SymbolBodyResult {
  symbol: string
  file: string
  startLine: number
  endLine: number
  sig: string
  text: string
}

/** Resolve a symbol name to its definition record (TS-aware, with a name-based fallback). */
function defOf(idx: LoadedIndex, name: string, file?: string): SymbolRecord | null {
  const d = pickDefinition(idx.symbols.symbols, name, file)
  if (d) return d
  return searchSymbols(idx, name, { limit: 5 }).filter((s) => s.n === name)[0] ?? null
}

/** Find a node by name in a per-file symbol tree, preferring an exact start-line match. */
function findNode(nodes: SymbolNode[] | undefined, name: string, line?: number): SymbolNode | null {
  const acc: SymbolNode[] = []
  const walk = (ns?: SymbolNode[]): void => {
    if (!ns) return
    for (const n of ns) {
      if (n.n === name) acc.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  if (acc.length === 0) return null
  if (line !== undefined) {
    const exact = acc.find((n) => n.l === line)
    if (exact) return exact
  }
  return acc[0]!
}

/**
 * Return the full source body of a symbol in one shot (definition → l..endL via the
 * AST symbol tree), redacted and capped — so the model gets the whole function
 * instead of Read-looping a file. Falls back to a fixed window when no AST range.
 */
export function symbolBody(
  root: string,
  idx: LoadedIndex,
  symbol: string,
  opts?: { file?: string; maxLines?: number },
): SymbolBodyResult | null {
  const name = symbol.trim()
  if (!name) return null
  const def = defOf(idx, name, opts?.file)
  if (!def) return null

  const maxLines = opts?.maxLines ?? 80
  const symtree = loadShard<SymbolTreeShard>(root, 'symtree')
  const node = findNode(symtree?.trees[def.f], name, def.l)
  const startLine = node?.l ?? def.l
  const endLine = node?.endL ?? startLine + maxLines - 1
  const raw = rangeSnippet(root, def.f, startLine, endLine, maxLines)
  if (raw === undefined) return null

  return {
    symbol: name,
    file: def.f,
    startLine,
    endLine: node?.endL ?? Math.min(endLine, startLine + maxLines - 1),
    sig: def.sig,
    text: redactSecrets(raw),
  }
}

export function renderSymbolBody(r: SymbolBodyResult): string {
  return [`## ${r.symbol} — ${r.file}:${r.startLine}-${r.endLine}`, '```', r.text, '```'].join('\n')
}
