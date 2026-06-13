import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { currentBranchKey } from '../../core/git'
import { dataDir } from '../../core/paths'
import type { RepoIdentity } from '../../core/types'
import { out, parseCommon } from '../shared'

export interface RepoListing {
  dirId: string
  repo: RepoIdentity | null
  branchKeys: string[]
  currentBranchKey?: string
}

/** Enumerate every indexed repo under ~/.claude-ctx/repos. */
export function listRepos(): RepoListing[] {
  const reposDir = join(dataDir(), 'repos')
  let dirs: string[]
  try {
    dirs = readdirSync(reposDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const out: RepoListing[] = []
  for (const dirId of dirs.sort()) {
    const base = join(reposDir, dirId)
    let repo: RepoIdentity | null = null
    try {
      repo = JSON.parse(readFileSync(join(base, 'repo.json'), 'utf8')) as RepoIdentity
    } catch {
      repo = null
    }
    let branchKeys: string[] = []
    try {
      branchKeys = readdirSync(join(base, 'branches'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      /* none */
    }
    const listing: RepoListing = { dirId, repo, branchKeys }
    if (repo && existsSync(repo.repoRoot)) listing.currentBranchKey = currentBranchKey(repo.repoRoot)
    out.push(listing)
  }
  return out
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const repos = listRepos()
  if (a.json) {
    out(JSON.stringify(repos, null, 2))
    return 0
  }
  if (repos.length === 0) {
    out('No indexed repos. Run: ctx index (in a repo) or ctx index --all (in a workspace).')
    return 0
  }
  for (const r of repos) {
    const name = r.repo?.repoName ?? r.dirId
    out(`${name}  [${r.repo?.repoId ?? r.dirId}]`)
    if (r.repo) out(`  root: ${r.repo.repoRoot}${r.repo.remoteUrl ? `  (${r.repo.remoteUrl})` : ''}`)
    const cur = r.currentBranchKey
    const branches = r.branchKeys.map((b) => (b === cur ? `* ${b}` : `  ${b}`))
    out(`  branches (${r.branchKeys.length}): ${branches.join(', ') || '(none)'}${cur ? `   [current: ${cur}]` : ''}`)
  }
  return 0
}
