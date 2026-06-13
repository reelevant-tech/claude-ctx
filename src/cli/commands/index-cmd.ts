import { loadConfig } from '../../core/config'
import { buildVectors } from '../../core/embed/build'
import { buildIndex } from '../../core/indexer/index'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { full: { type: 'boolean' }, 'no-embed': { type: 'boolean' } })
  const mode = a.values.full === true ? 'full' : undefined
  const stats = buildIndex(a.repo, { mode })
  out(
    `indexed ${a.repo}: ${stats.fileCount} files, ${stats.symbolCount} symbols, ` +
      `${stats.skippedCount} skipped, ${stats.durationMs}ms (${stats.mode})`,
  )

  const cfg = loadConfig(a.repo)
  if (cfg.embeddings.enabled && a.values['no-embed'] !== true) {
    const t0 = Date.now()
    const r = await buildVectors(a.repo, cfg)
    if (r.skipped) {
      out('embeddings: skipped (run `ctx embed-setup` to enable local semantic search)')
    } else {
      out(`embeddings: ${r.built} files embedded with ${r.model} in ${Date.now() - t0}ms`)
    }
  }
  return 0
}
