import { searchSymbols } from '../../cli/commands/symbols'
import { pickDefinition } from '../ast/ts-refs'
import { loadShard } from '../store/shards'
import type { CallsShard, LoadedIndex, SymbolRecord } from '../types'

/** How a callee name was resolved to a target file — surfaces confidence to the model. */
export type EdgeVia = 'same-file' | 'import' | 'heuristic' | 'external'

export interface ChainEdge {
  callee: string
  targetFile?: string
  via: EdgeVia
  line: number
}
export interface ChainNode {
  symbol: string
  file: string
  edges: { edge: ChainEdge; child?: ChainNode }[]
}

/**
 * Best-effort cross-file call chain from a symbol: walks intra-file call expressions
 * and resolves each callee to a target file via (1) same-file def, (2) a def in a
 * file imported by the caller (import graph), or (3) name-only (heuristic). Each edge
 * is labelled with how it was resolved. The exact chain needs the deferred cross-file
 * call graph; this trades precision for a one-call overview of execution flow.
 */
export function callChain(
  root: string,
  idx: LoadedIndex,
  symbol: string,
  opts?: { depth?: number; maxPerNode?: number },
): ChainNode | null {
  const shard = loadShard<CallsShard>(root, 'calls')
  if (!shard) return null
  const depth = opts?.depth ?? 3
  const maxPerNode = opts?.maxPerNode ?? 6

  const start =
    pickDefinition(idx.symbols.symbols, symbol.trim(), undefined) ??
    searchSymbols(idx, symbol.trim(), { limit: 5 }).filter((s) => s.n === symbol.trim())[0]
  if (!start) return null

  const byName = new Map<string, SymbolRecord[]>()
  for (const s of idx.symbols.symbols) {
    const a = byName.get(s.n)
    if (a) a.push(s)
    else byName.set(s.n, [s])
  }

  const visited = new Set<string>()

  const build = (name: string, file: string, d: number): ChainNode => {
    const node: ChainNode = { symbol: name, file, edges: [] }
    const key = `${file}#${name}`
    if (visited.has(key) || d <= 0) return node
    visited.add(key)

    const seen = new Set<string>()
    for (const c of shard.calls[file] ?? []) {
      if (c.caller !== name) continue
      if (seen.has(c.callee)) continue
      if (node.edges.length >= maxPerNode) break
      seen.add(c.callee)

      const cands = byName.get(c.callee) ?? []
      const sameFile = cands.find((s) => s.f === file)
      let edge: ChainEdge
      let child: ChainNode | undefined
      if (sameFile) {
        edge = { callee: c.callee, targetFile: file, via: 'same-file', line: c.line }
        child = build(c.callee, file, d - 1)
      } else {
        const imported = idx.graph.fwd[file] ?? []
        const viaImport = cands.find((s) => imported.includes(s.f))
        const target = viaImport ?? cands.find((s) => s.x) ?? cands[0]
        if (target) {
          edge = { callee: c.callee, targetFile: target.f, via: viaImport ? 'import' : 'heuristic', line: c.line }
          child = build(c.callee, target.f, d - 1)
        } else {
          edge = { callee: c.callee, via: 'external', line: c.line }
        }
      }
      node.edges.push({ edge, child })
    }
    return node
  }

  return build(start.n, start.f, depth)
}

export function renderCallChain(chain: ChainNode): string {
  const lines = [`## call_chain: ${chain.symbol}  [${chain.file}]`]
  const walk = (node: ChainNode, indent: string): void => {
    for (const { edge, child } of node.edges) {
      const tgt = edge.targetFile ? ` [${edge.targetFile}]` : ''
      lines.push(`${indent}→ ${edge.callee}()${tgt} (${edge.via})`)
      if (child && child.edges.length > 0) walk(child, `${indent}  `)
    }
  }
  walk(chain, '  ')
  if (lines.length === 1) lines.push('  (no outgoing calls found)')
  lines.push(
    '_Heuristic: callee = AST trailing identifier; cross-file resolved via name + import graph (via=import is import-backed, via=heuristic is name-only). Exact usage: mcp__ctx__references / trace_symbol._',
  )
  return lines.join('\n')
}
