import { loadConfig } from '../core/config'
import { readWarning } from '../core/guard/files'
import { loadState } from '../core/memory/state'
import { findRepoRoot, toRepoRelative } from '../core/paths'
import { loadShard } from '../core/store/shards'
import type { FilesShard, HookInput, HookOutput } from '../core/types'

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (cfg.guard.reads === 'off') return {}

  const fp = input.tool_input?.file_path
  if (typeof fp !== 'string') return {}
  const rel = toRepoRelative(root, fp)
  if (rel === null) return {}

  const files = loadShard<FilesShard>(root, 'files')
  const record = files?.files[rel] ?? null
  const state = loadState(root, input.session_id ?? 'unknown')

  const lines: string[] = []
  const warning = readWarning(rel, record, state.reads[rel] ?? 0)
  if (warning) lines.push(warning)

  // Read-cascade: the model is reading file-by-file without querying the index.
  // Nudge toward the one-shot context tools (throttled to streak 3,6,9…).
  const limit = cfg.cascadeReadLimit ?? 3
  const streak = state.readStreak ?? 0
  const cascade = limit > 0 && streak >= limit && streak % limit === 0
  if (cascade) {
    const task = state.firstPrompt ? `"${state.firstPrompt.slice(0, 80)}"` : 'your task'
    lines.push(
      `read ${streak} files this turn without querying the index — call mcp__ctx__context_pack(${task}) for the ranked files + key symbols + deps in one shot, or mcp__ctx__related_files(<path>) to expand. Stop reading files one-by-one to rediscover structure.`,
    )
  }

  if (lines.length === 0) return {}
  const additionalContext = lines.map((l) => `[claude-ctx] ${l}`).join('\n')
  const out: HookOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }
  // enforce mode (opt-in) turns the cascade nudge into a confirmation prompt
  if (cascade && cfg.guard.reads === 'enforce') {
    out.hookSpecificOutput!.permissionDecision = 'ask'
    out.hookSpecificOutput!.permissionDecisionReason =
      'Cascading reads without using the index. Call mcp__ctx__context_pack first, or confirm to read anyway.'
  }
  return out
}
