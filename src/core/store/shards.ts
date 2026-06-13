import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
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

export function loadPending(root: string): PendingShard {
  return loadShard<PendingShard>(root, 'pending') ?? { dirty: [], since: 0 }
}

/** Append dirty files (deduped) to pending.json. Used by the PostToolUse hook. */
export function appendPending(root: string, files: string[]): void {
  const pending = loadPending(root)
  const set = new Set(pending.dirty)
  for (const f of files) set.add(f)
  saveShard(root, 'pending', {
    dirty: [...set],
    since: pending.since || Math.floor(Date.now() / 1000),
  } satisfies PendingShard)
}

export function clearPending(root: string): void {
  saveShard(root, 'pending', { dirty: [], since: 0 } satisfies PendingShard)
}
