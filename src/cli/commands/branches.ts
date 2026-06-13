import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../../core/paths'
import type { IndexMeta } from '../../core/types'
import { listRepos } from './repos'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const key = (typeof a.values.repo === 'string' ? a.values.repo : a.positionals[0])?.trim()
  if (!key) {
    process.stderr.write('Usage: ctx branches --repo <repoName|repoId>\n')
    return 1
  }
  const match = listRepos().find(
    (r) => r.repo?.repoId === key || r.repo?.repoName === key || r.dirId === key,
  )
  if (!match) {
    out(`No indexed repo matching "${key}". Try: ctx repos`)
    return 0
  }
  const base = join(dataDir(), 'repos', match.dirId, 'branches')
  const rows: { branchKey: string; branch?: string; headCommit?: string; indexedAt?: string; files?: number }[] = []
  for (const branchKey of match.branchKeys) {
    let meta: IndexMeta | null = null
    try {
      meta = JSON.parse(readFileSync(join(base, branchKey, 'index', 'meta.json'), 'utf8')) as IndexMeta
    } catch {
      meta = null
    }
    rows.push({
      branchKey,
      branch: meta?.gitId?.branch,
      headCommit: meta?.gitId?.headCommit?.slice(0, 8),
      indexedAt: meta?.gitId?.indexedAt,
      files: meta?.fileCount,
    })
  }
  if (a.json) {
    out(JSON.stringify({ repo: match.repo, branches: rows }, null, 2))
    return 0
  }
  out(`${match.repo?.repoName ?? match.dirId} — ${rows.length} indexed branch(es):`)
  for (const r of rows) {
    const cur = r.branchKey === match.currentBranchKey ? '* ' : '  '
    out(`${cur}${r.branchKey}  (${r.branch ?? '?'})  ${r.headCommit ?? ''}  files=${r.files ?? '?'}  ${r.indexedAt ?? ''}`)
  }
  return 0
}
