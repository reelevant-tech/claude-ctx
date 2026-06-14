import { loadConfig } from '../core/config'
import { classifyBashCommand } from '../core/guard/bash'
import { appendEvent } from '../core/memory/log'
import { findRepoRoot } from '../core/paths'
import { loadMeta } from '../core/store/shards'
import type { GuardTier, GuardVerdict, HookInput, HookOutput, HookSpecificOutput } from '../core/types'
import { enumerationNudge, extractSearchQuery, searchPackContext } from './search-context'

const RANK: Record<GuardTier, number> = { severe: 3, destructive: 2, inefficient: 1 }

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (cfg.inject.shadow === true) return {} // observe-only: no steering, no guard
  const sid = input.session_id ?? 'unknown'
  const command = String(input.tool_input?.command ?? '')
  if (!command) return {}
  const meta = loadMeta(root)

  // ranked index matches for a `grep`/`find`/`rg` content search; else, for a bare
  // file enumeration (find/ls -R/tree), steer to the tree tools. Both independent
  // of the bash guard. The nudge is gated on an index existing (else its tools are useless).
  const sq = extractSearchQuery(command)
  const searchCtx = sq ? searchPackContext(root, sid, sq) : null
  const injected = searchCtx ?? (meta ? enumerationNudge(command) : null)

  // bash safety/efficiency guard
  let guardBody: string | null = null
  let decision: 'deny' | 'ask' | undefined
  let reason: string | undefined
  if (cfg.guard.bash !== 'off') {
    const verdicts = classifyBashCommand(command, {
      repoRoot: root,
      secretGlobs: meta?.secretGlobs ?? [],
      riskyGlobs: meta?.riskyGlobs ?? [],
    })
    if (verdicts.length > 0) {
      const worst = verdicts.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a))
      try {
        appendEvent(root, sid, {
          ts: Math.floor(Date.now() / 1000),
          e: 'guard',
          kind:
            cfg.guard.bash === 'enforce'
              ? worst.tier === 'severe'
                ? 'deny'
                : worst.tier === 'destructive'
                  ? 'ask'
                  : 'warn'
              : 'warn',
          target: command.slice(0, 80),
        })
      } catch {
        /* best-effort */
      }
      guardBody = renderVerdicts(verdicts)
      if (cfg.guard.bash === 'enforce') {
        if (worst.tier === 'severe') {
          decision = 'deny'
          reason = worst.reason
        } else if (worst.tier === 'destructive') {
          decision = 'ask'
          reason = worst.reason
        }
      }
    }
  }

  const additionalContext = [guardBody, injected].filter(Boolean).join('\n\n')
  if (!additionalContext && !decision) return {}

  const hs: HookSpecificOutput = { hookEventName: 'PreToolUse' }
  if (decision) {
    hs.permissionDecision = decision
    hs.permissionDecisionReason = reason
  }
  if (additionalContext) hs.additionalContext = additionalContext
  return { hookSpecificOutput: hs }
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
