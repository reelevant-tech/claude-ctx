import { distillSession } from '../core/memory/distill'
import { latestSessionId } from '../core/memory/log'
import { findRepoRoot } from '../core/paths'
import type { HookInput, HookOutput } from '../core/types'

export async function handle(input: HookInput): Promise<HookOutput> {
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const sid = input.session_id ?? latestSessionId(root) ?? 'unknown'
  try {
    distillSession(root, sid)
  } catch {
    /* best-effort */
  }
  return {}
}
