import { loadConfig } from '../core/config'
import { classifyBashCommand } from '../core/guard/bash'
import { appendEvent } from '../core/memory/log'
import { findRepoRoot } from '../core/paths'
import { loadMeta } from '../core/store/shards'
import type { GuardTier, GuardVerdict, HookInput, HookOutput } from '../core/types'

const RANK: Record<GuardTier, number> = { severe: 3, destructive: 2, inefficient: 1 }

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (cfg.guard.bash === 'off') return {}

  const command = String(input.tool_input?.command ?? '')
  if (!command) return {}
  const meta = loadMeta(root)
  const verdicts = classifyBashCommand(command, {
    repoRoot: root,
    secretGlobs: meta?.secretGlobs ?? [],
    riskyGlobs: meta?.riskyGlobs ?? [],
  })
  if (verdicts.length === 0) return {}

  const worst = verdicts.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a))
  try {
    appendEvent(root, input.session_id ?? 'unknown', {
      ts: Math.floor(Date.now() / 1000),
      e: 'guard',
      kind: cfg.guard.bash === 'enforce' ? (worst.tier === 'severe' ? 'deny' : worst.tier === 'destructive' ? 'ask' : 'warn') : 'warn',
      target: command.slice(0, 80),
    })
  } catch {
    /* best-effort */
  }

  const body = renderVerdicts(verdicts)
  if (cfg.guard.bash === 'enforce') {
    if (worst.tier === 'severe') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: worst.reason,
          additionalContext: body,
        },
      }
    }
    if (worst.tier === 'destructive') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: worst.reason,
          additionalContext: body,
        },
      }
    }
  }
  // warn mode (default) — never set permissionDecision
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: body } }
}

function renderVerdicts(verdicts: GuardVerdict[]): string {
  const lines = ['[claude-ctx guard]']
  for (const v of verdicts) {
    const prefix = v.tier === 'severe' ? 'WARNING (severe): ' : v.tier === 'destructive' ? 'Caution: ' : ''
    let line = `- ${prefix}${v.reason}`
    if (v.suggestion) line += ` — ${v.suggestion}`
    lines.push(line)
  }
  return lines.join('\n')
}
