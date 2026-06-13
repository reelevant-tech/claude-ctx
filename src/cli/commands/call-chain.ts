import { callChain, renderCallChain } from '../../core/trace/call-chain'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { depth: { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const symbol = a.positionals.join(' ').trim()
  if (!symbol) {
    process.stderr.write('Usage: ctx call-chain <symbol> [--depth N]\n')
    return 1
  }
  const depth = typeof a.values.depth === 'string' ? Number(a.values.depth) : undefined
  const chain = callChain(a.repo, idx, symbol, { depth })
  if (!chain) {
    out(`Could not build a call chain for "${symbol}".`)
    return 0
  }
  if (a.json) {
    out(JSON.stringify(chain, null, 2))
    return 0
  }
  out(renderCallChain(chain))
  return 0
}
