import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '../core/config'
import { ensureIndex } from '../core/indexer/ensure'
import { findRepoRoot, summaryPath } from '../core/paths'
import { renderOverview } from '../core/router/render'
import { loadIndex } from '../core/store/shards'
import type { HookInput, HookOutput, RepoSummary } from '../core/types'

function cliJsPath(): string {
  return join(dirname(process.argv[1] ?? ''), 'cli.cjs')
}

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

  const status = ensureIndex(root, { cliJs: cliJsPath(), waitForSmall: input.source !== 'compact' })
  const idx = loadIndex(root)
  if (!idx || idx.meta.partial) {
    if (status.status === 'building') {
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
  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctxText },
  }
}
