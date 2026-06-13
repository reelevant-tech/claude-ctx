import { appendEvent } from '../core/memory/log'
import { bumpRead, recordEdit } from '../core/memory/state'
import { findRepoRoot, toRepoRelative } from '../core/paths'
import { appendPending } from '../core/store/shards'
import type { HookInput, HookOutput } from '../core/types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export async function handle(input: HookInput): Promise<HookOutput> {
  // memory is always on (no config gate)
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const sid = input.session_id ?? 'unknown'
  const tool = input.tool_name ?? ''
  const now = Math.floor(Date.now() / 1000)
  const ti = input.tool_input ?? {}

  try {
    if (tool === 'Read') {
      const rel = typeof ti.file_path === 'string' ? toRepoRelative(root, ti.file_path) : null
      if (rel !== null) {
        bumpRead(root, sid, rel)
        appendEvent(root, sid, { ts: now, e: 'read', f: rel })
      }
    } else if (EDIT_TOOLS.has(tool)) {
      const rel = typeof ti.file_path === 'string' ? toRepoRelative(root, ti.file_path) : null
      if (rel !== null) {
        recordEdit(root, sid, rel)
        appendEvent(root, sid, { ts: now, e: 'edit', f: rel, tool })
        appendPending(root, [rel])
      }
    } else if (tool === 'Bash') {
      const cmd = String(ti.command ?? '')
      if (cmd) appendEvent(root, sid, { ts: now, e: 'bash', cmd: cmd.slice(0, 200) })
    }
  } catch {
    /* memory is best-effort */
  }
  return {}
}
