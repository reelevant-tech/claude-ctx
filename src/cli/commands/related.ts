import { toRepoRelative } from '../../core/paths'
import { relatedFiles, type RelatedGroups } from '../../core/related'
import { out, parseCommon, requireIndex } from '../shared'

export { relatedFiles, type RelatedGroups }

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
