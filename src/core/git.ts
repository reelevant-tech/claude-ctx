/**
 * Git identity, branch resolution, and multi-repo discovery.
 *
 * Two tiers:
 *  - HOT PATH (file reads only, no subprocess): resolveGitDir, readHead,
 *    branchKeyFromHead, currentBranchKey. Safe to call from hooks/path layer.
 *  - BUILD TIME (may spawn git): gitTopLevel, headCommit, isDirty, remoteUrl,
 *    gitIdentity, discoverRepos. Called only from cli/mcp index paths.
 *
 * No heavy deps — safe to live in the hook bundle (only node builtins).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitIdentity } from './types'

// ---------------------------------------------------------------------------
// Hot-path: branch key from .git/HEAD (no subprocess)
// ---------------------------------------------------------------------------

export interface HeadInfo {
  branch?: string
  commit?: string
}

/** Resolve the git dir for a worktree root: `<root>/.git` (dir) or the path in
 * a `.git` *file* (linked worktrees/submodules). Null when not a git repo. */
export function resolveGitDir(root: string): string | null {
  const dotgit = join(root, '.git')
  try {
    const st = lstatSync(dotgit)
    if (st.isDirectory()) return dotgit
    if (st.isFile()) {
      const m = readFileSync(dotgit, 'utf8').trim().match(/^gitdir:\s*(.+)$/)
      if (m?.[1]) return isAbsolute(m[1]) ? m[1] : resolve(root, m[1])
    }
  } catch {
    /* not a repo */
  }
  return null
}

/** Parse `.git/HEAD` to a branch name or a detached commit. File read only. */
export function readHead(root: string): HeadInfo | null {
  const gitDir = resolveGitDir(root)
  if (!gitDir) return null
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (ref?.[1]) return { branch: ref[1] }
    if (/^[0-9a-f]{40}$/i.test(head)) return { commit: head }
    return {}
  } catch {
    return null
  }
}

function sha6(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 6)
}

/** Filesystem-safe slug of a branch name (handles `/`, spaces, unicode). */
export function sanitizeBranch(b: string): string {
  const s = b
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'branch'
}

/**
 * Branch key: sanitized branch + short hash of the raw name (collision-safe for
 * `feature/auth` vs `feature-auth`). Detached -> `detached-<short>`. Unknown ->
 * `unknown`. Branch names are never used raw as path segments.
 */
export function branchKeyFromHead(head: HeadInfo | null): string {
  if (head?.branch) return `${sanitizeBranch(head.branch)}-${sha6(head.branch)}`
  if (head?.commit) return `detached-${head.commit.slice(0, 12)}`
  return 'unknown'
}

/** Current branch key for a repo root (file-based; safe on the hook hot path). */
export function currentBranchKey(root: string): string {
  return branchKeyFromHead(readHead(root))
}

// ---------------------------------------------------------------------------
// Build-time: subprocess git (only from cli/mcp)
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
}

/** `git rev-parse --show-toplevel` — the actual repo root, or null if not a repo. */
export function gitTopLevel(cwd: string): string | null {
  const out = git(cwd, ['rev-parse', '--show-toplevel'])
  return out ? resolve(out) : null
}

export function headCommit(root: string): string | undefined {
  return git(root, ['rev-parse', 'HEAD']) ?? undefined
}

export function isDirty(root: string): boolean {
  const out = git(root, ['status', '--porcelain'])
  return out !== null && out.length > 0
}

export function remoteUrl(root: string): string | undefined {
  return git(root, ['config', '--get', 'remote.origin.url']) ?? undefined
}

/** Full git identity for the index/vector metadata (build time). */
export function gitIdentity(root: string): GitIdentity {
  const head = readHead(root)
  const id: GitIdentity = {
    branchKey: branchKeyFromHead(head),
    dirty: isDirty(root),
    indexedAt: new Date().toISOString(),
  }
  if (head?.branch) id.branch = head.branch
  const hc = headCommit(root) ?? head?.commit
  if (hc) id.headCommit = hc
  return id
}

// ---------------------------------------------------------------------------
// Multi-repo discovery
// ---------------------------------------------------------------------------

const DISCOVERY_SKIP = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  'third_party',
  '.cache',
  '.claude-ctx',
])

/**
 * Discover git repos under a workspace dir. A repo = a dir containing `.git`
 * (dir or file). Descends into found repos to surface nested repos/submodules,
 * but never into `.git`/excluded dirs. Returns absolute repo roots, sorted.
 */
export function discoverRepos(workspace: string, maxDepth = 8): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasGit = entries.some((e) => e.name === '.git')
    if (hasGit) {
      const real = resolve(dir)
      if (!seen.has(real)) {
        seen.add(real)
        found.push(real)
      }
      // keep descending for nested repos/submodules (but skip .git below)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === '.git' || DISCOVERY_SKIP.has(e.name)) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(resolve(workspace), 0)
  return found.sort()
}
