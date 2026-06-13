import type { CommandInfo } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  if (a.json) {
    out(JSON.stringify(idx.commands.commands, null, 2))
    return 0
  }
  if (idx.commands.commands.length === 0) {
    out('No commands detected.')
    return 0
  }
  const byKind = new Map<string, CommandInfo[]>()
  for (const c of idx.commands.commands) {
    const arr = byKind.get(c.kind) ?? []
    arr.push(c)
    byKind.set(c.kind, arr)
  }
  for (const [kind, cmds] of byKind) {
    out(`${kind}:`)
    for (const c of cmds) out(`  ${c.cmd}  (${c.src})`)
  }
  return 0
}
