import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { days: { type: 'string' }, limit: { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const days = typeof a.values.days === 'string' ? Number(a.values.days) : 7
  const limit = typeof a.values.limit === 'string' ? Number(a.values.limit) : 20
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  const recent = idx.git.recent.filter((r) => r.ts >= cutoff).slice(0, limit)
  if (a.json) {
    out(JSON.stringify(recent, null, 2))
    return 0
  }
  if (recent.length === 0) {
    out(`No changes in the last ${days} days (or not a git repo).`)
    return 0
  }
  out(`Recent changes (last ${days}d):`)
  for (const r of recent) {
    const co = idx.git.cochange[r.f]
    const coStr = co && co.length > 0 ? `  (co-changes: ${co.slice(0, 3).map(([f]) => f).join(', ')})` : ''
    out(`  ${r.f} — ${r.subject}${coStr}`)
  }
  return 0
}
