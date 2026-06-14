import { loadConfig } from '../core/config'
import { redactSecrets } from '../core/guard/redact'
import { appendEvent } from '../core/memory/log'
import { loadState, markSurfaced, setFirstPrompt } from '../core/memory/state'
import { findRepoRoot } from '../core/paths'
import { buildPack } from '../core/router/pack'
import { renderPack } from '../core/router/render'
import { loadIndex } from '../core/store/shards'
import { estimateTokens, isConversationalPrompt } from '../core/tokens'
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

  // Decide what (if anything) to inject. A weak pack is doubly costly — it adds
  // tokens AND can mislead — so the confidence gate suppresses low-confidence
  // packs and trims medium ones. confidenceGate defaults on; set false for the
  // legacy "inject any non-empty pack" behaviour (used as the A/B baseline).
  const gate = cfg.inject.confidenceGate !== false
  // Show the full mcp__ctx__* catalogue only on the first injection of a session
  // (surfaced is still empty then); after that a one-line recap is enough.
  const firstInjection = (state.surfaced?.length ?? 0) === 0
  const body = pack.files.length === 0 ? null : renderBody(pack, gate, firstInjection)

  // shadow mode computes everything but injects nothing — the logged pack event
  // (with `injected: false`) lets us measure overlap with what the model reads.
  const shadow = cfg.inject.shadow === true
  const injected = body !== null && !shadow

  try {
    appendEvent(root, sid, {
      ts: Math.floor(Date.now() / 1000),
      e: 'pack',
      confidence: pack.confidence,
      files: pack.files.slice(0, 10).map((f) => f.path),
      tok: body ? estimateTokens(body) : 0,
      injected,
    })
  } catch {
    /* memory is best-effort */
  }

  if (!injected || body === null) return {}
  // Reads of these ranked files are "following the index", not a blind cascade.
  try {
    markSurfaced(root, sid, pack.files.map((f) => f.path))
  } catch {
    /* memory is best-effort */
  }
  return {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body },
  }
}

const FULL_PREAMBLE =
  '[claude-ctx] Files most relevant to this request, already indexed and ranked — start from these. ' +
  'Read them directly; do NOT grep the repo or read files one-by-one to rediscover what is below. ' +
  'Expand with mcp__ctx__related_files / dep_trace, or mcp__ctx__context_pack for a fuller pack.'

const COMPACT_PREAMBLE =
  '[claude-ctx] Likely relevant files (ranked) — read these first; do NOT grep to rediscover them.'

const LOW_LINE =
  '[claude-ctx] No clearly relevant files ranked for this prompt — try mcp__ctx__context_pack if you need a fuller search.'

/** Render the string to inject, gated by confidence: high → full pack, medium →
 * compact pack, low → a one-line nudge. When the gate is off, always full.
 * `toolFooter` prints the full tool catalogue (first injection of a session only). */
function renderBody(pack: ReturnType<typeof buildPack>, gate: boolean, toolFooter: boolean): string {
  if (!gate || pack.confidence === 'high') return `${FULL_PREAMBLE}\n${renderPack(pack, { toolFooter })}`
  if (pack.confidence === 'medium') return `${COMPACT_PREAMBLE}\n${renderPack(pack, { compact: true })}`
  return LOW_LINE
}
