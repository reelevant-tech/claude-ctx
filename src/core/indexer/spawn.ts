/**
 * Hook-safe index rebuild trigger. Spawns the cli bundle — never imports index.ts.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { loadPending } from '../store/shards'

/** Path to cli.cjs next to the running bundle (hook.cjs or cli.cjs). */
export function cliJsPath(): string {
  return join(dirname(process.argv[1] ?? ''), 'cli.cjs')
}

export function spawnIndexBuild(root: string, cliJs: string, opts?: { full?: boolean }): void {
  try {
    const args = [cliJs, 'index', '--repo', root]
    if (opts?.full) args.push('--full')
    spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* fail open */
  }
}

/** Kick off an incremental rebuild (background). Safe from hooks. */
export function requestIndexRefresh(root: string, cliJs: string, opts?: { full?: boolean }): void {
  spawnIndexBuild(root, cliJs, opts)
}

/** After a build finishes, rerun if edits landed while the lock was held. */
export function respawnIfPending(root: string, cliJs: string): void {
  if (loadPending(root).dirty.length > 0) spawnIndexBuild(root, cliJs)
}
