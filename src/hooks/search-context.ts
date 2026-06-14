import { loadConfig } from '../core/config'
import { redactSecrets } from '../core/guard/redact'
import { loadState, markSurfaced } from '../core/memory/state'
import { buildPack } from '../core/router/pack'
import { loadIndex } from '../core/store/shards'
import type { LoadedIndex } from '../core/types'

/**
 * Shared logic for turning a search (Grep/Glob tool, or a `grep`/`find`/`rg`
 * Bash command) into injected, ranked index matches. Hook-safe: depends only on
 * the lexical pack builder (BM25F + graph + recency) — never the embedder, so it
 * stays out of the embed/ast/typescript import cone forbidden in hook.cjs. The
 * full hybrid (with vectors) remains MCP-only via mcp__ctx__context_pack.
 */

/** Strip regex/glob metacharacters & punctuation so a grep pattern reads as search tokens. */
export function cleanQuery(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z]/g, ' ') // regex classes: \b \w \d \s …
    .replace(/[()[\]{}^$.*+?|\\/'"`<>=:;,!@#%&~]/g, ' ') // metachars, path sep, punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

/** The grep/rg content pattern, if any — checked first (it's the strongest intent). */
function grepPattern(c: string): string | null {
  const m = c.match(/\b(?:grep|egrep|fgrep|rg|ag|ack|git\s+grep)\b\s+(.*)$/s)
  if (!m) return null
  const rest = m[1]!
  // explicit -e PATTERN
  const eM = rest.match(/(?:^|\s)-e\s+(['"]?)(.+?)\1(?:\s|$)/)
  if (eM) {
    const q = cleanQuery(eM[2]!)
    return q.length >= 2 ? q : null
  }
  // otherwise the first non-flag, non-brace token (respecting quotes)
  const tokens = rest.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")/g) ?? []
  for (const t of tokens) {
    if (t.startsWith('-') || t === '{}' || t.startsWith('$')) continue
    const q = cleanQuery(t)
    return q.length >= 2 ? q : null
  }
  return null
}

/** The find -name/-path glob, if any. */
function findName(c: string): string | null {
  const m = c.match(/\bfind\b[^|]*?\s-i?(?:name|path)\s+(['"]?)([^'"\s]+)\1/)
  if (!m) return null
  const q = cleanQuery(m[2]!)
  return q.length >= 2 ? q : null
}

/**
 * Best-effort extraction of the search term from a Bash command.
 * Prefers the grep/rg content pattern (incl. inside `find … -exec grep …` or a
 * pipe) over a `find -name` glob — the content pattern is the real intent, the
 * name glob is usually just a file-type filter. Returns null for non-search cmds.
 */
export function extractSearchQuery(command: string): string | null {
  const c = command.trim()
  return grepPattern(c) ?? findName(c)
}

const ENUM_NUDGE =
  '[claude-ctx] Listing files — the index already has the layout. Use mcp__ctx__repo_tree (optionally scoped to a dir), mcp__ctx__repo_overview (packages, entrypoints, commands), or mcp__ctx__context_pack("<task>") for the files that matter — instead of enumerating with find/ls -R/tree.'

/**
 * A bare file-enumeration command (find/ls -R/tree with no content grep) has no
 * semantic term to rank — steer it to the structural tools instead. Returns the
 * nudge text, or null when the command isn't a file enumeration.
 */
export function enumerationNudge(command: string): string | null {
  const c = command.trim()
  const isFind = /\bfind\b/.test(c) && /\s-(?:i?name|type|i?path|maxdepth)\b/.test(c)
  const isLsR = /\bls\b[^|]*\s-\w*R/.test(c)
  const isTree = /(?:^|[|&;]\s*)tree\b/.test(c)
  return isFind || isLsR || isTree ? ENUM_NUDGE : null
}

/** When the query is a single identifier matching an indexed symbol, return its
 * definition line so the nudge *carries the answer* — the model rarely needs the
 * grep or a follow-up symbol_search. Prefers exported defs. Signature redacted. */
function symbolDefLine(q: string, idx: LoadedIndex): string | null {
  const tok = q.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(tok)) return null // single identifier only
  const lower = tok.toLowerCase()
  let best: (typeof idx.symbols.symbols)[number] | undefined
  for (const s of idx.symbols.symbols) {
    if (s.n.toLowerCase() !== lower) continue
    if (!best || (s.x && !best.x)) best = s
    if (best.x) break
  }
  if (!best) return null
  const sig = best.sig ? ` — ${redactSecrets(best.sig).slice(0, 100)}` : ''
  return `→ ${best.n} (${best.k}) ${best.f}:${best.l}${sig}`
}

/**
 * Build an injected "ranked indexed matches for this search" block, or null when
 * there is no usable query / no index / no matches.
 */
export function searchPackContext(root: string, sessionId: string, rawQuery: string): string | null {
  const q = cleanQuery(rawQuery)
  if (q.length < 3) return null

  const idx = loadIndex(root)
  if (!idx || idx.meta.partial) return null

  const cfg = loadConfig(root)
  const state = loadState(root, sessionId)
  const pack = buildPack(q, idx, state, {
    budget: Math.min(cfg.packBudgetTokens, 600),
    withExcerpts: false,
    root,
    redact: redactSecrets,
    aliases: cfg.tokenAliases,
  })
  if (pack.files.length === 0) return null

  // reading these ranked files is "following the index", not a blind cascade
  try {
    markSurfaced(root, sessionId, pack.files.map((f) => f.path))
  } catch {
    /* memory is best-effort */
  }

  const def = symbolDefLine(q, idx)
  const files = pack.files
    .slice(0, 4)
    .map((f) => `- ${f.path} — ${f.why.slice(0, 2).join('; ')}`)
    .join('\n')
  return (
    `[claude-ctx] Ranked indexed matches for "${q}" — start from these instead of the raw search output:\n` +
    (def ? `${def}\n` : '') +
    `${files}\n` +
    `_Lexical rank; semantic/fuller: mcp__ctx__context_pack("${q}") · mcp__ctx__symbol_search_`
  )
}
