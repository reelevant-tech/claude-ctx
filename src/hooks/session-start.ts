import { readFileSync } from 'node:fs'
import { loadConfig } from '../core/config'
import { ensureIndex } from '../core/indexer/ensure'
import { cliJsPath } from '../core/indexer/spawn'
import { appendEvent } from '../core/memory/log'
import { findRepoRoot, summaryPath } from '../core/paths'
import { renderOverview } from '../core/router/render'
import { loadIndex } from '../core/store/shards'
import { estimateTokens } from '../core/tokens'
import type { HookInput, HookOutput, RepoSummary } from '../core/types'

function loadSummary(root: string): RepoSummary | null {
  try {
    return JSON.parse(readFileSync(summaryPath(root), 'utf8')) as RepoSummary
  } catch {
    return null
  }
}

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (!cfg.inject.sessionStart) return {}
  const sid = input.session_id ?? 'unknown'
  // shadow mode computes the overview and logs its cost, but injects nothing.
  const shadow = cfg.inject.shadow === true

  const status = ensureIndex(root, { cliJs: cliJsPath(), waitForSmall: input.source !== 'compact' })
  const idx = loadIndex(root)
  if (!idx || idx.meta.partial) {
    if (status.status === 'building' && !shadow) {
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            '[claude-ctx] Repo index building in background — mcp__ctx__* tools return partial results until ready.',
        },
      }
    }
    return {}
  }

  const ctxText = renderOverview(idx, loadSummary(root), cfg.overviewBudgetTokens, {
    compactRecap: input.source === 'compact',
  })
  try {
    appendEvent(root, sid, {
      ts: Math.floor(Date.now() / 1000),
      e: 'overview',
      tok: estimateTokens(ctxText),
      injected: !shadow,
    })
  } catch {
    /* memory is best-effort */
  }
  if (shadow) return {}
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctxText },
  }
}
