import { posix } from 'node:path'
import { toRepoRelative } from '../../core/paths'
import type { LoadedIndex } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

export interface RelatedGroups {
  imports: string[]
  importedBy: string[]
  coChanged: string[]
  tests: string[]
  sameDir: string[]
  namingSiblings: string[]
}

export function relatedFiles(idx: LoadedIndex, rel: string): RelatedGroups {
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

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const arg = a.positionals[0]
  if (!arg) {
    process.stderr.write('Usage: ctx related <path>\n')
    return 1
  }
  const rel = toRepoRelative(a.repo, arg)
  if (rel === null || !idx.files.files[rel]) {
    out(`Not in index: ${arg}`)
    return 0
  }
  const g = relatedFiles(idx, rel)
  if (a.json) {
    out(JSON.stringify(g, null, 2))
    return 0
  }
  const section = (label: string, items: string[]) => {
    if (items.length > 0) out(`${label}: ${items.join(', ')}`)
  }
  out(`Related to ${rel}:`)
  section('  Imports', g.imports)
  section('  Imported by', g.importedBy)
  section('  Co-changed', g.coChanged)
  section('  Tests', g.tests)
  section('  Same directory', g.sameDir)
  section('  Naming siblings', g.namingSiblings)
  return 0
}
