import { loadConfig } from '../core/config'
import { redactSecrets } from '../core/guard/redact'
import { appendEvent } from '../core/memory/log'
import { loadState, setFirstPrompt } from '../core/memory/state'
import { findRepoRoot } from '../core/paths'
import { buildPack } from '../core/router/pack'
import { renderPack } from '../core/router/render'
import { loadIndex } from '../core/store/shards'
import { isConversationalPrompt } from '../core/tokens'
import type { HookInput, HookOutput } from '../core/types'

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const cfg = loadConfig(root)
  if (!cfg.inject.userPromptSubmit) return {}

  const prompt = input.prompt ?? ''
  const sid = input.session_id ?? 'unknown'
  // record the prompt for memory even when we skip injection
  try {
    setFirstPrompt(root, sid, prompt)
    appendEvent(root, sid, { ts: Math.floor(Date.now() / 1000), e: 'prompt', text: prompt.slice(0, 200) })
  } catch {
    /* memory is best-effort */
  }

  if (isConversationalPrompt(prompt)) return {}
  const idx = loadIndex(root)
  if (!idx || idx.meta.partial) return {}

  const state = loadState(root, sid)
  const pack = buildPack(prompt, idx, state, {
    budget: cfg.packBudgetTokens,
    withExcerpts: true,
    root,
    redact: redactSecrets,
    aliases: cfg.tokenAliases,
  })
  if (pack.files.length === 0) return {}
  const preamble =
    '[claude-ctx] Files most relevant to this request, already indexed and ranked — start from these. ' +
    'Read them directly; do NOT grep the repo or read files one-by-one to rediscover what is below. ' +
    'Expand with mcp__ctx__related_files / dep_trace, or mcp__ctx__context_pack for a fuller pack.'
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${preamble}\n${renderPack(pack)}`,
    },
  }
}
