import { loadConfig } from '../../core/config'
import { classifyRisk } from '../../core/indexer/risk'
import { toRepoRelative } from '../../core/paths'
import { out, parseCommon, requireIndex } from '../shared'

const GUIDANCE: Record<string, string> = {
  secret: 'secret — never read or index its contents; edit manually.',
  generated: 'generated — edits will be overwritten; change the source generator.',
  vendor: 'vendor — third-party code; do not edit in place.',
  infra: 'infra/prod-sensitive — confirm with the user before changing.',
  huge: 'large file — use mcp__ctx__symbol_search to find the relevant section.',
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const arg = a.positionals[0]
  if (!arg) {
    process.stderr.write('Usage: ctx risky <path>\n')
    return 1
  }
  const rel = toRepoRelative(a.repo, arg)
  if (rel === null) {
    out(`Path outside repo: ${arg}`)
    return 0
  }
  const cfg = loadConfig(a.repo)
  const { kind, risk } = classifyRisk(rel, cfg)
  const rec = idx.files.files[rel]
  const allRisk = new Set<string>([...risk, ...(rec?.risk ?? [])])
  if (allRisk.size === 0) {
    out(`${rel}: ok (${kind ?? rec?.kind ?? 'source'}) — no risk flags.`)
    return 0
  }
  out(`${rel}: ${[...allRisk].join(', ')}`)
  for (const r of allRisk) if (GUIDANCE[r]) out(`  - ${GUIDANCE[r]}`)
  return 0
}
