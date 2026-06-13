import { loadShard } from '../../core/store/shards'
import { traceSymbol, renderTraceSymbol } from '../../core/trace/symbol'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, {
    file: { type: 'string' },
    depth: { type: 'string' },
  })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const symbol = a.positionals.join(' ').trim()
  if (!symbol) {
    process.stderr.write('Usage: ctx trace <symbol> [--file <path>] [--depth N]\n')
    return 1
  }
  const file = typeof a.values.file === 'string' ? a.values.file : undefined
  const depth = typeof a.values.depth === 'string' ? Number(a.values.depth) : undefined
  const result = traceSymbol(a.repo, idx, symbol, { file, depth })
  if (!result) {
    out(`Could not trace "${symbol}".`)
    return 0
  }
  if (a.json) {
    out(JSON.stringify(result, null, 2))
    return 0
  }
  out(renderTraceSymbol(a.repo, result))
  return 0
}

// re-export for MCP
export { traceSymbol, renderTraceSymbol } from '../../core/trace/symbol'
