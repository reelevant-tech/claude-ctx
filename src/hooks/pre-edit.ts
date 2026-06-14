import { loadConfig } from '../core/config'
import { classifyEditTarget } from '../core/guard/files'
import { appendEvent } from '../core/memory/log'
import { loadState, markTestsReminded } from '../core/memory/state'
import { findRepoRoot, toRepoRelative } from '../core/paths'
import { loadShard } from '../core/store/shards'
import type { FilesShard, HookInput, HookOutput } from '../core/types'

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (cfg.inject.shadow === true) return {} // observe-only: no steering, no guard
  if (cfg.guard.edits === 'off') return {}

  const fp = input.tool_input?.file_path
  if (typeof fp !== 'string') return {}
  const rel = toRepoRelative(root, fp)
  if (rel === null) return {}

  const files = loadShard<FilesShard>(root, 'files')
  const record = files?.files[rel] ?? null
  const verdict = classifyEditTarget(rel, record, cfg)

  const extras: string[] = []
  // tests nudge (fires once per file per session)
  const sid = input.session_id ?? 'unknown'
  const state = loadState(root, sid)
  if (record && record.tests.length > 0) {
    const unread = record.tests.filter((t) => (state.reads[t] ?? 0) === 0)
    if (unread.length === record.tests.length && !state.testsReminded.includes(rel)) {
      extras.push(
        `Related tests not yet read: ${record.tests.join(', ')} — consider reading or running them (mcp__ctx__find_tests).`,
      )
      try {
        markTestsReminded(root, sid, rel)
      } catch {
        /* best-effort */
      }
    }
  }

  if (!verdict && extras.length === 0) return {}

  try {
    appendEvent(root, sid, {
      ts: Math.floor(Date.now() / 1000),
      e: 'guard',
      kind: verdict && cfg.guard.edits === 'enforce' ? (verdict.tier === 'severe' ? 'deny' : 'ask') : 'warn',
      target: rel,
    })
  } catch {
    /* best-effort */
  }

  const bodyLines = ['[claude-ctx guard]']
  if (verdict) bodyLines.push(`- ${verdict.reason}`)
  for (const e of extras) bodyLines.push(`- ${e}`)
  const body = bodyLines.join('\n')

  if (verdict && cfg.guard.edits === 'enforce') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.tier === 'severe' ? 'deny' : 'ask',
        permissionDecisionReason: verdict.reason,
        additionalContext: body,
      },
    }
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: body } }
}
