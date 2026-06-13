import { renderSymbolBody, symbolBody } from '../../core/trace/body'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { file: { type: 'string' }, 'max-lines': { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const symbol = a.positionals.join(' ').trim()
  if (!symbol) {
    process.stderr.write('Usage: ctx body <symbol> [--file <path>] [--max-lines N]\n')
    return 1
  }
  const file = typeof a.values.file === 'string' ? a.values.file : undefined
  const maxLines = typeof a.values['max-lines'] === 'string' ? Number(a.values['max-lines']) : undefined
  const r = symbolBody(a.repo, idx, symbol, { file, maxLines })
  if (!r) {
    out(`Could not locate the body of "${symbol}".`)
    return 0
  }
  if (a.json) {
    out(JSON.stringify(r, null, 2))
    return 0
  }
  out(renderSymbolBody(r))
  return 0
}
