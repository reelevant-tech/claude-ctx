import type { SymbolRecord } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

export function searchSymbols(
  idx: { symbols: { symbols: SymbolRecord[]; tokenIndex: Record<string, number[]> } },
  query: string,
  opts: { kind?: string; exportedOnly?: boolean; limit?: number },
): SymbolRecord[] {
  const q = query.toLowerCase()
  const hits = new Set<number>()
  for (const i of idx.symbols.tokenIndex[q] ?? []) hits.add(i)
  idx.symbols.symbols.forEach((s, i) => {
    if (s.n.toLowerCase().includes(q)) hits.add(i)
  })
  let results = [...hits].map((i) => idx.symbols.symbols[i]!).filter(Boolean)
  if (opts.kind) results = results.filter((s) => s.k === opts.kind)
  if (opts.exportedOnly) results = results.filter((s) => s.x)
  // exact name first, then by file/line
  results.sort((a, b) => {
    const ea = a.n.toLowerCase() === q ? 0 : 1
    const eb = b.n.toLowerCase() === q ? 0 : 1
    if (ea !== eb) return ea - eb
    return a.f < b.f ? -1 : a.f > b.f ? 1 : a.l - b.l
  })
  return results.slice(0, opts.limit ?? 20)
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, {
    kind: { type: 'string' },
    exported: { type: 'boolean' },
    limit: { type: 'string' },
  })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const query = a.positionals.join(' ').trim()
  if (!query) {
    process.stderr.write('Usage: ctx symbols <query>\n')
    return 1
  }
  const results = searchSymbols(idx, query, {
    kind: typeof a.values.kind === 'string' ? a.values.kind : undefined,
    exportedOnly: a.values.exported === true,
    limit: typeof a.values.limit === 'string' ? Number(a.values.limit) : 20,
  })
  if (a.json) {
    out(JSON.stringify(results, null, 2))
    return 0
  }
  if (results.length === 0) {
    out(`No symbols matching "${query}".`)
    return 0
  }
  for (const s of results) {
    const ex = s.x ? '' : ' (private)'
    out(`${s.n}  ${s.k}  ${s.f}:${s.l}${ex}  — ${s.sig}`)
  }
  return 0
}
