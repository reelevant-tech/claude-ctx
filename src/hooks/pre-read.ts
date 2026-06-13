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
  const warning = readWarning(rel, record, state.reads[rel] ?? 0)
  if (!warning) return {}
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[claude-ctx] ${warning}` },
  }
}
