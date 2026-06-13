import { loadShard } from '../../core/store/shards'
import type { CallsShard } from '../../core/types'
import { out, parseCommon } from '../shared'

export interface Reference {
  file: string
  line: number
  caller?: string
}

/** Name-based call sites of a symbol across all files (best-effort: ignores shadowing/overloads). */
export function findReferences(shard: CallsShard, symbol: string): Reference[] {
  const refs: Reference[] = []
  for (const file of Object.keys(shard.calls).sort()) {
    for (const c of shard.calls[file]!) {
      if (c.callee === symbol) refs.push(c.caller ? { file, line: c.line, caller: c.caller } : { file, line: c.line })
    }
  }
  return refs
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const symbol = a.positionals[0]
  if (!symbol) {
    process.stderr.write('Usage: ctx references <symbol>\n')
    return 1
  }
  const shard = loadShard<CallsShard>(a.repo, 'calls')
  if (!shard) {
    process.stderr.write('No call data. Run: ctx index\n')
    process.exitCode = 1
    return 1
  }
  const refs = findReferences(shard, symbol)
  if (a.json) {
    out(JSON.stringify(refs, null, 2))
    return 0
  }
  if (refs.length === 0) {
    out(`No call sites found for "${symbol}" (name-based, intra-file calls only).`)
    return 0
  }
  out(`Call sites of "${symbol}" (best-effort, name-based — verify before relying on it):`)
  for (const r of refs) out(`  ${r.file}:${r.line}${r.caller ? `  in ${r.caller}()` : ''}`)
  return 0
}
