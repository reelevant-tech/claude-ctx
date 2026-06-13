import type { GraphShard } from '../types'

export function buildGraph(fwdEdges: Map<string, Set<string>>): GraphShard {
  const fwd: Record<string, string[]> = {}
  const revSets = new Map<string, Set<string>>()
  for (const from of [...fwdEdges.keys()].sort()) {
    const tos = [...(fwdEdges.get(from) ?? [])].filter((t) => t !== from).sort()
    if (tos.length === 0) continue
    fwd[from] = tos
    for (const t of tos) {
      let s = revSets.get(t)
      if (!s) {
        s = new Set()
        revSets.set(t, s)
      }
      s.add(from)
    }
  }
  const rev: Record<string, string[]> = {}
  const centrality: Record<string, number> = {}
  for (const t of [...revSets.keys()].sort()) {
    const sources = [...(revSets.get(t) ?? [])].sort()
    rev[t] = sources
    centrality[t] = sources.length
  }
  return { fwd, rev, centrality }
}

const MAX_FRONTIER = 5000

/**
 * Up to maxPaths minimal-length paths from->to over fwd edges.
 * Neighbors visited in sorted order so output is deterministic.
 */
export function shortestPaths(
  graph: GraphShard,
  from: string,
  to: string,
  maxPaths = 3,
): string[][] {
  if (maxPaths <= 0) return []
  if (from === to) return [[from]]
  const results: string[][] = []
  const depth = new Map<string, number>([[from, 0]])
  let frontier: string[][] = [[from]]
  let found = false
  while (frontier.length > 0 && !found) {
    const next: string[][] = []
    const first = frontier[0]
    if (first === undefined) break
    const d = first.length // nodes expanded this round land at depth d
    for (const path of frontier) {
      const last = path[path.length - 1]
      if (last === undefined) continue
      for (const nb of [...(graph.fwd[last] ?? [])].sort()) {
        const seen = depth.get(nb)
        if (seen !== undefined && seen < d) continue // reachable shorter — never on a shortest path here
        if (path.includes(nb)) continue
        if (seen === undefined) depth.set(nb, d)
        if (nb === to) {
          results.push([...path, nb])
          found = true
          if (results.length >= maxPaths) return results
        } else if (!found && next.length < MAX_FRONTIER) {
          next.push([...path, nb])
        }
      }
    }
    frontier = next
  }
  return results
}
