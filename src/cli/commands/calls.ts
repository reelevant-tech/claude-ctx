import { renderCalls } from '../../core/ast/render'
import { toRepoRelative } from '../../core/paths'
import { loadShard } from '../../core/store/shards'
import type { CallsShard } from '../../core/types'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const arg = a.positionals[0]
  if (!arg) {
    process.stderr.write('Usage: ctx calls <file>\n')
    return 1
  }
  const rel = toRepoRelative(a.repo, arg)
  if (rel === null) {
    out(`Path outside repo: ${arg}`)
    return 0
  }
  const shard = loadShard<CallsShard>(a.repo, 'calls')
  if (!shard) {
    process.stderr.write('No call data. Run: ctx index\n')
    process.exitCode = 1
    return 1
  }
  const calls = shard.calls[rel] ?? []
  if (a.json) {
    out(JSON.stringify(calls, null, 2))
    return 0
  }
  out(`Calls in ${rel} (intra-file, best-effort):`)
  out(renderCalls(calls))
  return 0
}
