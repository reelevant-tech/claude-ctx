import { buildTreeSummary } from '../../core/indexer/tree'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { dir: { type: 'string' }, depth: { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const dir = typeof a.values.dir === 'string' ? a.values.dir.replace(/\/+$/, '') : ''
  if (!dir) {
    out(idx.meta.treeSummary || '(empty)')
    return 0
  }
  const prefix = dir + '/'
  const files = Object.keys(idx.files.files)
    .filter((f) => f.startsWith(prefix))
    .map((rel) => ({ rel: rel.slice(prefix.length) }))
  out(buildTreeSummary(files))
  return 0
}
