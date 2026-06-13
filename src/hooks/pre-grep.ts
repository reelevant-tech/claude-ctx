import { resolve } from 'node:path'
import { findRepoRoot } from '../core/paths'
import type { HookInput, HookOutput } from '../core/types'

/** Nudge toward indexed lookups when a Grep/Glob spans the whole repo. */
export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const ti = input.tool_input ?? {}
  const path = typeof ti.path === 'string' ? ti.path : undefined
  const pattern = typeof ti.pattern === 'string' ? ti.pattern : ''
  const narrowed = ti.glob !== undefined || ti.type !== undefined

  const wholeRepo = path === undefined || path === '.' || resolve(root, path) === resolve(root)
  if (!wholeRepo || narrowed) return {}

  const p = pattern.length > 40 ? `${pattern.slice(0, 40)}...` : pattern
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[claude-ctx] Indexed repo — consider mcp__ctx__symbol_search("${p}") or mcp__ctx__related_files instead of a repo-wide search.`,
    },
  }
}
