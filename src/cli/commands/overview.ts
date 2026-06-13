import { readFileSync } from 'node:fs'
import { loadConfig } from '../../core/config'
import { summaryPath } from '../../core/paths'
import { renderOverview } from '../../core/router/render'
import type { RepoSummary } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

function loadSummary(root: string): RepoSummary | null {
  try {
    return JSON.parse(readFileSync(summaryPath(root), 'utf8')) as RepoSummary
  } catch {
    return null
  }
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const cfg = loadConfig(a.repo)
  out(renderOverview(idx, loadSummary(a.repo), cfg.overviewBudgetTokens))
  return 0
}
