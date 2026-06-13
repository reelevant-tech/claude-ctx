import { loadConfig } from '../core/config'
import { redactSecrets } from '../core/guard/redact'
import { loadState } from '../core/memory/state'
import { buildPack } from '../core/router/pack'
import { loadIndex } from '../core/store/shards'

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

  const files = pack.files
    .slice(0, 6)
    .map((f) => `- ${f.path} — ${f.why.slice(0, 2).join('; ')}`)
    .join('\n')
  return (
    `[claude-ctx] Ranked indexed matches for "${q}" — start from these instead of the raw search output:\n` +
    `${files}\n` +
    `_Lexical rank; semantic/fuller: mcp__ctx__context_pack("${q}") · mcp__ctx__symbol_search_`
  )
}
