/**
 * Hook-safe index freshness gate. MUST NOT import index.ts / parse-ts.ts /
 * parse-rust.ts (or anything pulling in the `typescript` package) — re-indexing
 * is delegated to the cli bundle via spawn. The esbuild hook-bundle guard
 * enforces this. Never throws.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadConfig } from '../config'
import { isLocked } from '../store/lock'
import { loadPending, loadShard, saveShard } from '../store/shards'
import { spawnIndexBuild } from './spawn'
import type { CtxConfig, EnsureIndexResult, GitShard, IndexMeta } from '../types'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { indexDir } from '../paths'

const STALE_PROBE_COUNT = 30

/** Cheap staleness probe: have any recently-indexed files changed since indexedAt? */
function looksFresh(root: string, meta: IndexMeta): boolean {
  if (meta.partial) return false
  if (loadPending(root).dirty.length > 0) return false
  const probe: string[] = []
  const git = loadShard<GitShard>(root, 'git')
  if (git) for (const r of git.recent) probe.push(r.f)
  if (probe.length < STALE_PROBE_COUNT) {
    const files = loadShard<{ files: Record<string, unknown> }>(root, 'files')
    if (files) for (const k of Object.keys(files.files)) {
      probe.push(k)
      if (probe.length >= STALE_PROBE_COUNT) break
    }
  }
  const tolerance = meta.indexedAt + 2
  let checked = 0
  for (const rel of probe.slice(0, STALE_PROBE_COUNT)) {
    try {
      const st = statSync(join(root, rel))
      if (Math.floor(st.mtimeMs / 1000) > tolerance) return false
      checked++
    } catch {
      return false // a tracked file vanished -> stale
    }
  }
  return checked > 0 || probe.length === 0
}

/** Fast file-count estimate without a full index. */
function quickCount(root: string, cfg: CtxConfig): number {
  if (existsSync(join(root, '.git'))) {
    try {
      const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.split('\n').filter(Boolean).length
    } catch {
      /* fall through */
    }
  }
  // non-git or git failure: assume large so we go background (safe default)
  return cfg.bgIndexThresholdFiles + 1
}

export function ensureIndex(
  root: string,
  opts: { cliJs: string; waitForSmall?: boolean; config?: CtxConfig },
): EnsureIndexResult {
  try {
    const cfg = opts.config ?? loadConfig(root)
    const meta = loadShard<IndexMeta>(root, 'meta')

    if (meta && looksFresh(root, meta)) return { status: 'fresh' }

    // Someone is already building.
    if (isLocked(root)) return { status: meta ? 'fresh' : 'building' }

    // Stale but present: refresh in background, current index still usable.
    if (meta) {
      spawnIndexBuild(root, opts.cliJs)
      return { status: 'fresh' }
    }

    // No index at all.
    const count = quickCount(root, cfg)
    if (count <= cfg.bgIndexThresholdFiles && opts.waitForSmall) {
      try {
        spawnSync(process.execPath, [opts.cliJs, 'index', '--repo', root, '--full'], {
          timeout: 120_000,
          stdio: 'ignore',
        })
      } catch {
        /* fall through to status check */
      }
      return { status: loadShard<IndexMeta>(root, 'meta') ? 'fresh' : 'missing' }
    }

    // Large repo: stub a partial meta so MCP can report "building", then build detached.
    try {
      const stub: IndexMeta = {
        version: 1,
        root,
        repoId: '',
        indexedAt: 0,
        indexDurationMs: 0,
        fileCount: 0,
        skippedCount: 0,
        isGit: existsSync(join(root, '.git')),
        projectType: 'unknown',
        packages: [],
        treeSummary: '',
        riskyGlobs: [],
        secretGlobs: [],
        partial: true,
      }
      // only write a stub if no index dir contents exist yet
      if (!existsSync(join(indexDir(root), 'meta.json'))) saveShard(root, 'meta', stub)
    } catch {
      /* ignore */
    }
    spawnIndexBuild(root, opts.cliJs, { full: true })
    return { status: 'building' }
  } catch {
    return { status: 'missing' }
  }
}
