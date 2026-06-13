import { readFileSync } from 'node:fs'
import { summaryPath } from '../../core/paths'
import type { RepoSummary } from '../../core/types'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  let summary: RepoSummary | null = null
  try {
    summary = JSON.parse(readFileSync(summaryPath(a.repo), 'utf8')) as RepoSummary
  } catch {
    summary = null
  }
  if (a.json) {
    out(JSON.stringify(summary ?? { updatedAt: 0, sessions: [] }, null, 2))
    return 0
  }
  if (!summary || summary.sessions.length === 0) {
    out('No session history.')
    return 0
  }
  for (const s of summary.sessions) {
    out(`• ${s.task}`)
    if (s.filesEdited.length > 0) out(`  edited: ${s.filesEdited.join(', ')}`)
    if (s.commands.length > 0) out(`  commands: ${s.commands.join('; ')}`)
    for (const n of s.notes) out(`  note: ${n}`)
  }
  return 0
}
