import { parseArgs } from 'node:util'
import { findRepoRoot } from '../core/paths'
import { loadIndex } from '../core/store/shards'
import type { LoadedIndex } from '../core/types'

export interface CommonArgs {
  repo: string
  json: boolean
  positionals: string[]
  values: Record<string, string | boolean | undefined>
}

/** Parse --repo/--json plus the given option spec; resolve repo root. */
export function parseCommon(
  argv: string[],
  options: Record<string, { type: 'string' | 'boolean'; short?: string }> = {},
): CommonArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      repo: { type: 'string' },
      json: { type: 'boolean' },
      ...options,
    },
  })
  const repoArg = typeof values.repo === 'string' ? values.repo : process.cwd()
  return {
    repo: findRepoRoot(repoArg).root,
    json: values.json === true,
    positionals,
    values: values as Record<string, string | boolean | undefined>,
  }
}

/** Load the index or print a one-line hint and return null (sets exitCode). */
export function requireIndex(root: string): LoadedIndex | null {
  const idx = loadIndex(root)
  if (!idx) {
    process.stderr.write('No index for this repo. Run: ctx index\n')
    process.exitCode = 1
    return null
  }
  return idx
}

export function out(s: string): void {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n')
}
