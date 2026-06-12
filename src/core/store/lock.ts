import { readFileSync, rmSync } from 'node:fs'
import { lockPath } from '../paths'
import { writeFileAtomic } from './shards'

interface LockInfo {
  pid: number
  startedAt: number // epoch ms
}

const STALE_MS = 10 * 60 * 1000

function readLock(root: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(root), 'utf8')) as LockInfo
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function isLockStale(info: LockInfo): boolean {
  if (Date.now() - info.startedAt > STALE_MS) return true
  return !pidAlive(info.pid)
}

/** True if someone else currently holds a live (non-stale) lock. */
export function isLocked(root: string): boolean {
  const info = readLock(root)
  if (!info) return false
  if (isLockStale(info)) return false
  return true
}

/**
 * Try to take the index lock. Returns true on success.
 * Not perfectly race-free (write+rename, no O_EXCL) — acceptable: worst case
 * two indexers run and the later atomic shard rename wins with valid data.
 */
export function acquireLock(root: string): boolean {
  if (isLocked(root)) return false
  writeFileAtomic(lockPath(root), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  return true
}

export function releaseLock(root: string): void {
  try {
    const info = readLock(root)
    if (info && info.pid !== process.pid) return // not ours
    rmSync(lockPath(root), { force: true })
  } catch {
    /* fail-open */
  }
}
