import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

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

export function indexDir(root: string): string {
  return join(repoDataDir(root), 'index')
}

export function sessionsDir(root: string): string {
  return join(repoDataDir(root), 'sessions')
}

export function summaryPath(root: string): string {
  return join(repoDataDir(root), 'summary.json')
}

export function lockPath(root: string): string {
  return join(repoDataDir(root), 'index.lock')
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
