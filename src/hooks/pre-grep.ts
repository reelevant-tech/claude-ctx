import { resolve } from 'node:path'
import { findRepoRoot } from '../core/paths'
import type { HookInput, HookOutput } from '../core/types'
import { searchPackContext } from './search-context'

/** On a Grep/Glob, inject ranked indexed matches for the pattern; else nudge toward indexed lookups. */
export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const sid = input.session_id ?? 'unknown'
  const ti = input.tool_input ?? {}
  const path = typeof ti.path === 'string' ? ti.path : undefined
  const pattern = typeof ti.pattern === 'string' ? ti.pattern : ''
  const narrowed = ti.glob !== undefined || ti.type !== undefined
  const wholeRepo = path === undefined || path === '.' || resolve(root, path) === resolve(root)

  const parts: string[] = []

  // ranked files for the search intent (the pattern is the query)
  const ctx = pattern ? searchPackContext(root, sid, pattern) : null
  if (ctx) parts.push(ctx)

  // if we couldn't rank anything, fall back to the repo-wide nudge
  if (!ctx && wholeRepo && !narrowed) {
    const p = pattern.length > 40 ? `${pattern.slice(0, 40)}...` : pattern
    parts.push(
      `[claude-ctx] Indexed repo — consider mcp__ctx__symbol_search("${p}"), mcp__ctx__trace_symbol, or mcp__ctx__references instead of a repo-wide search.`,
    )
  }

  if (parts.length === 0) return {}
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') },
  }
}
