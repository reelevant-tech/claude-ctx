import { shortestPaths } from '../../core/indexer/graph'
import { toRepoRelative } from '../../core/paths'
import { out, parseCommon, requireIndex } from '../shared'

const ARROW = ' → '

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const fromArg = a.positionals[0]
  if (!fromArg) {
    process.stderr.write('Usage: ctx deps <from> [to]\n')
    return 1
  }
  const from = toRepoRelative(a.repo, fromArg)
  if (from === null || !idx.files.files[from]) {
    out(`Not in index: ${fromArg}`)
    return 0
  }
  const toArg = a.positionals[1]
  if (toArg) {
    const to = toRepoRelative(a.repo, toArg)
    if (to === null) {
      out(`Not in index: ${toArg}`)
      return 0
    }
    const paths = shortestPaths(idx.graph, from, to, 3)
    if (paths.length === 0) out(`No dependency path from ${from} to ${to}.`)
    else for (const p of paths) out(p.join(ARROW))
    return 0
  }
  const fanout = idx.graph.fwd[from] ?? []
  const fanin = idx.graph.rev[from] ?? []
  out(`${from} (centrality ${idx.graph.centrality[from] ?? 0}):`)
  if (fanout.length > 0) out(`  imports (${fanout.length}): ${fanout.join(', ')}`)
  if (fanin.length > 0) out(`  imported by (${fanin.length}): ${fanin.join(', ')}`)
  if (fanout.length === 0 && fanin.length === 0) out('  no dependency edges')
  return 0
}
