import { buildIndex } from '../../core/indexer/index'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { full: { type: 'boolean' } })
  const mode = a.values.full === true ? 'full' : undefined
  const stats = buildIndex(a.repo, { mode })
  out(
    `indexed ${a.repo}: ${stats.fileCount} files, ${stats.symbolCount} symbols, ` +
      `${stats.skippedCount} skipped, ${stats.durationMs}ms (${stats.mode})`,
  )
  return 0
}
