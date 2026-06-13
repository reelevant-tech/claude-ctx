import { loadConfig } from '../../core/config'
import { latestSessionId } from '../../core/memory/log'
import { loadState } from '../../core/memory/state'
import { redactSecrets } from '../../core/guard/redact'
import { buildPack } from '../../core/router/pack'
import { renderPack } from '../../core/router/render'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { budget: { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const task = a.positionals.join(' ').trim()
  if (!task) {
    process.stderr.write('Usage: ctx pack "<task description>"\n')
    return 1
  }
  const cfg = loadConfig(a.repo)
  const budget = typeof a.values.budget === 'string' ? Number(a.values.budget) : cfg.packBudgetTokens
  const sid = latestSessionId(a.repo) ?? 'cli'
  const state = loadState(a.repo, sid)
  const pack = buildPack(task, idx, state, {
    budget: Number.isFinite(budget) ? budget : cfg.packBudgetTokens,
    withExcerpts: true,
    root: a.repo,
    redact: redactSecrets,
  })
  out(a.json ? JSON.stringify(pack, null, 2) : renderPack(pack))
  return 0
}
