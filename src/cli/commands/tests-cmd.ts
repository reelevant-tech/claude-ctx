import { toRepoRelative } from '../../core/paths'
import type { LoadedIndex } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

/** Best test command, preferring the file's own package. */
export function bestTestCommand(idx: LoadedIndex, rel: string): string | null {
  const rec = idx.files.files[rel]
  const tests = idx.commands.commands.filter((c) => c.kind === 'test')
  if (tests.length === 0) return null
  if (rec && rec.pkg >= 0) {
    const scoped = tests.find((c) => c.pkg === rec.pkg)
    if (scoped) return scoped.cmd
  }
  return tests[0]!.cmd
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const arg = a.positionals[0]
  if (!arg) {
    process.stderr.write('Usage: ctx tests <path>\n')
    return 1
  }
  const rel = toRepoRelative(a.repo, arg)
  if (rel === null || !idx.files.files[rel]) {
    out(`Not in index: ${arg}`)
    return 0
  }
  const rec = idx.files.files[rel]!
  const selfTest = rec.tests.includes(rel)
  const tests = rec.tests.filter((t) => t !== rel)
  if (a.json) {
    out(JSON.stringify({ tests, selfTest, command: bestTestCommand(idx, rel) }, null, 2))
    return 0
  }
  if (tests.length > 0) out(`Tests for ${rel}: ${tests.join(', ')}`)
  else out(`No mapped test files for ${rel}.`)
  if (selfTest) out('  (contains inline #[cfg(test)] tests)')
  const cmd = bestTestCommand(idx, rel)
  if (cmd) out(`Run: ${cmd}`)
  return 0
}
