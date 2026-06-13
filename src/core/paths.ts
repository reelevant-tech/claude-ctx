import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { currentBranchKey, remoteUrl } from './git'
import type { RepoIdentity } from './types'

/** Root data dir: ~/.claude-ctx (overridable for tests via CLAUDE_CTX_HOME). */
export function dataDir(): string {
  return process.env.CLAUDE_CTX_HOME ?? join(homedir(), '.claude-ctx')
}

export interface RepoRoot {
  root: string
  isGit: boolean
}

/**
 * Nearest ancestor containing .git (dir or file — worktrees use a .git file).
 * Falls back to the cwd itself (non-git mode). Never spawns a process: this
 * runs on the hook hot path.
 */
export function findRepoRoot(cwd: string): RepoRoot {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return { root: dir, isGit: true }
    const parent = dirname(dir)
    if (parent === dir) return { root: resolve(cwd), isGit: false }
    dir = parent
  }
}

/** Stable per-repo id: <basename>-<sha256(realpath) first 12 hex>. */
export function repoId(root: string): string {
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    /* keep as-is */
  }
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 12)
  const name = basename(real).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo'
  return `${name}-${hash}`
}

export function repoDataDir(root: string): string {
  return join(dataDir(), 'repos', repoId(root))
}

/** Repo-level identity file (one per repo, all branches). */
export function repoJsonPath(root: string): string {
  return join(repoDataDir(root), 'repo.json')
}

/** Per-branch directory. branchKey defaults to the repo's current branch. */
export function branchDir(root: string, branchKey?: string): string {
  return join(repoDataDir(root), 'branches', branchKey ?? currentBranchKey(root))
}

/** Branch-keyed index directory — all shards live here. */
export function indexDir(root: string): string {
  return join(branchDir(root), 'index')
}

/** Legacy (pre-branch) index dir; only read for migration/cleanup. */
export function legacyIndexDir(root: string): string {
  return join(repoDataDir(root), 'index')
}

/** Sessions/memory stay repo-level (not branch-keyed). */
export function sessionsDir(root: string): string {
  return join(repoDataDir(root), 'sessions')
}

export function summaryPath(root: string): string {
  return join(repoDataDir(root), 'summary.json')
}

/** Index lock is per-branch (two branches can index concurrently). */
export function lockPath(root: string): string {
  return join(branchDir(root), 'index.lock')
}

/** Stable repo identity for shard metadata. repoId/repoRoot are realpath-based
 * (never the workspace launch dir); remoteUrl is best-effort provenance. */
export function repoIdentity(root: string): RepoIdentity {
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    /* keep as-is */
  }
  const id: RepoIdentity = { repoId: repoId(root), repoName: basename(real), repoRoot: real }
  const url = remoteUrl(root)
  if (url) id.remoteUrl = url
  return id
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Normalize an absolute or relative path to a repo-relative POSIX path, or null if outside the repo. */
export function toRepoRelative(root: string, p: string): string | null {
  const abs = resolve(root, p)
  const normRoot = resolve(root)
  if (abs === normRoot) return ''
  if (!abs.startsWith(normRoot + '/')) return null
  return abs.slice(normRoot.length + 1).split('\\').join('/')
}
