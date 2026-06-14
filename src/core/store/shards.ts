import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { indexDir } from '../paths'
import type {
  CommandsShard,
  FilesShard,
  GitShard,
  GraphShard,
  IndexMeta,
  LoadedIndex,
  PendingShard,
  ShardName,
  SymbolsShard,
  VectorsShard,
} from '../types'

export function shardPath(root: string, name: ShardName): string {
  return join(indexDir(root), `${name}.json`)
}

/** mtime in ms, or null if the shard doesn't exist. */
export function shardMtimeMs(root: string, name: ShardName): number | null {
  try {
    return statSync(shardPath(root, name)).mtimeMs
  } catch {
    return null
  }
}

/** Load one shard; null when missing or unparseable (treat as no-index). */
export function loadShard<T>(root: string, name: ShardName): T | null {
  try {
    return JSON.parse(readFileSync(shardPath(root, name), 'utf8')) as T
  } catch {
    return null
  }
}

/** Atomic write: temp file in the same dir + rename. */
export function saveShard(root: string, name: ShardName, value: unknown): void {
  const path = shardPath(root, name)
  writeFileAtomic(path, JSON.stringify(value))
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export function loadMeta(root: string): IndexMeta | null {
  return loadShard<IndexMeta>(root, 'meta')
}

/** Load all shards the router/MCP need. Null if no usable index (missing meta). */
export function loadIndex(root: string): LoadedIndex | null {
  const meta = loadMeta(root)
  if (!meta) return null
  const files = loadShard<FilesShard>(root, 'files') ?? { files: {} }
  const symbols = loadShard<SymbolsShard>(root, 'symbols') ?? { symbols: [], tokenIndex: {} }
  const graph = loadShard<GraphShard>(root, 'graph') ?? { fwd: {}, rev: {}, centrality: {} }
  const git = loadShard<GitShard>(root, 'git') ?? { recent: [], churn: {}, cochange: {} }
  const commands = loadShard<CommandsShard>(root, 'commands') ?? { commands: [] }
  const vectors = loadShard<VectorsShard>(root, 'vectors')
  const idx: LoadedIndex = { meta, files, symbols, graph, git, commands }
  if (vectors) idx.vectors = vectors
  return idx
}

/**
 * Pending dirty-file queue. Append-only JSONL (one `{f,ts}` per line) so two
 * concurrent PostToolUse hooks — parallel tool calls or separate sessions —
 * can't clobber each other via a read-modify-write race. Mirrors appendEvent.
 */
function pendingPath(root: string): string {
  return join(indexDir(root), 'pending.jsonl')
}

export function loadPending(root: string): PendingShard {
  let raw: string
  try {
    raw = readFileSync(pendingPath(root), 'utf8')
  } catch {
    return { dirty: [], since: 0 }
  }
  const set = new Set<string>()
  let since = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const ev = JSON.parse(t) as { f?: unknown; ts?: unknown }
      if (typeof ev.f !== 'string') continue
      set.add(ev.f)
      if (typeof ev.ts === 'number' && (since === 0 || ev.ts < since)) since = ev.ts
    } catch {
      // torn/corrupt line (e.g. interrupted append): skip silently
    }
  }
  return { dirty: [...set], since }
}

/** Append dirty files to the queue. One O_APPEND write keeps small lines atomic
 *  across processes (no read-modify-write). Used by the PostToolUse hook. */
export function appendPending(root: string, files: string[]): void {
  if (files.length === 0) return
  const path = pendingPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const ts = Math.floor(Date.now() / 1000)
  let buf = ''
  for (const f of files) buf += `${JSON.stringify({ f, ts })}\n`
  appendFileSync(path, buf)
}

/** Drop the whole queue (truncate). */
export function clearPending(root: string): void {
  try {
    rmSync(pendingPath(root), { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Remove only `processed` from the queue, preserving any files appended while a
 * build was running — so a mid-build edit survives and still triggers
 * respawnIfPending instead of going stale until its next mtime change.
 */
export function clearPendingSubset(root: string, processed: string[]): void {
  if (processed.length === 0) return
  const drop = new Set(processed)
  const survivors = loadPending(root).dirty.filter((f) => !drop.has(f))
  if (survivors.length === 0) {
    clearPending(root)
    return
  }
  const ts = Math.floor(Date.now() / 1000)
  writeFileAtomic(pendingPath(root), `${survivors.map((f) => JSON.stringify({ f, ts })).join('\n')}\n`)
}
