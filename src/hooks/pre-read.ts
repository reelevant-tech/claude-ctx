import { loadConfig } from '../core/config'
import { isSecretTarget, readWarning } from '../core/guard/files'
import { appendEvent } from '../core/memory/log'
import { loadState } from '../core/memory/state'
import { findRepoRoot, toRepoRelative } from '../core/paths'
import { loadShard } from '../core/store/shards'
import type { FilesShard, HookInput, HookOutput } from '../core/types'

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (cfg.inject.shadow === true) return {} // observe-only: no steering
  if (cfg.guard.reads === 'off') return {}

  const fp = input.tool_input?.file_path
  if (typeof fp !== 'string') return {}
  const rel = toRepoRelative(root, fp)
  if (rel === null) return {}

  const files = loadShard<FilesShard>(root, 'files')
  const record = files?.files[rel] ?? null

  // Secret files: a Read returns the raw credentials to the model, and redaction
  // can't reach the Read tool's own output — only a deny prevents the leak. Block
  // whenever the read guard is on (escape hatch: guard.reads: 'off'). The bash
  // guard already covers `cat .env`; this closes the direct-Read path.
  if (isSecretTarget(rel, record, cfg)) {
    try {
      appendEvent(root, input.session_id ?? 'unknown', {
        ts: Math.floor(Date.now() / 1000),
        e: 'guard',
        kind: 'deny',
        target: rel,
      })
    } catch {
      /* best-effort */
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'credentials file — reading would leak secrets into context',
        additionalContext: '[claude-ctx guard] blocked read of a credentials file (.env/*.pem/*.key/…)',
      },
    }
  }

  const state = loadState(root, input.session_id ?? 'unknown')

  const lines: string[] = []
  const warning = readWarning(rel, record, state.reads[rel] ?? 0)
  if (warning) lines.push(warning)

  // Read-cascade: the model is reading file-by-file (of files the index did NOT
  // surface — see bumpRead) without querying it. Nudge twice then stay quiet to
  // avoid banner-blindness: a full reminder at the limit, a short last one at 2×,
  // silence after (until an index query resets the streak).
  const limit = cfg.cascadeReadLimit ?? 3
  const streak = state.readStreak ?? 0
  const firstNudge = limit > 0 && streak === limit
  const lastNudge = limit > 0 && streak === 2 * limit
  const cascade = firstNudge || lastNudge
  if (cascade) {
    const task = state.firstPrompt ? `"${state.firstPrompt.slice(0, 80)}"` : 'your task'
    lines.push(
      firstNudge
        ? `read ${streak} files this turn without querying the index — call mcp__ctx__context_pack(${task}) for the ranked files + key symbols + deps in one shot, or mcp__ctx__related_files(<path>) to expand. Stop reading files one-by-one to rediscover structure.`
        : `still reading file-by-file (${streak}) — one mcp__ctx__context_pack(${task}) would replace these. Last index reminder this streak.`,
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
