import { posix } from 'node:path'
import type { FilesShard, GitShard, GraphShard } from './types'

export interface RelatedGroups {
  imports: string[]
  importedBy: string[]
  coChanged: string[]
  tests: string[]
  sameDir: string[]
  namingSiblings: string[]
}

/** Minimal slice of the index needed for neighbourhood lookup (no symbols/
 * vectors), so hot-path callers (the PostToolUse hook) can load just 3 shards. */
export interface RelatedInput {
  files: FilesShard
  graph: GraphShard
  git: GitShard
}

/** A file's neighbourhood: imports, importers, co-changed, tests, same-dir,
 * naming siblings. Pure — no IO, no heavy deps (safe in the hook bundle). */
export function relatedFiles(idx: RelatedInput, rel: string): RelatedGroups {
  const rec = idx.files.files[rel]
  const imports = idx.graph.fwd[rel] ?? []
  const importedBy = idx.graph.rev[rel] ?? []
  const coChanged = (idx.git.cochange[rel] ?? []).map(([f]) => f)
  const tests = rec ? [...rec.tests, ...(rec.testedBy ? [rec.testedBy] : [])] : []
  const dir = posix.dirname(rel)
  const sameDir = Object.keys(idx.files.files)
    .filter((f) => f !== rel && posix.dirname(f) === dir)
    .sort()
    .slice(0, 10)
  const stem = posix.basename(rel).split('.')[0] ?? ''
  const namingSiblings = Object.keys(idx.files.files)
    .filter((f) => f !== rel && (posix.basename(f).split('.')[0] ?? '') === stem && posix.dirname(f) !== dir)
    .sort()
    .slice(0, 10)
  return { imports, importedBy, coChanged, tests, sameDir, namingSiblings }
}
