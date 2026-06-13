import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/config'
import { collectGitSignals, headCommit } from '../../src/core/indexer/gitsig'

// this file lives at test/unit/, repo root is two levels up
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('collectGitSignals', () => {
  it('collects signals from this repo for known files', () => {
    const known = new Set(['package.json', 'src/core/types.ts'])
    const sig = collectGitSignals(repoRoot, DEFAULT_CONFIG, known)

    const recentFiles = sig.shard.recent.map((r) => r.f)
    expect(recentFiles).toContain('package.json')
    expect(recentFiles).toContain('src/core/types.ts')
    expect(sig.shard.recent.length).toBeLessThanOrEqual(50)

    for (const r of sig.shard.recent) {
      expect(r.ts).toBeGreaterThan(0)
      expect(r.subject.length).toBeLessThanOrEqual(80)
      expect(known.has(r.f)).toBe(true)
    }

    const pkg = sig.perFile.get('package.json')
    expect(pkg).toBeDefined()
    expect(pkg!.lastTs).toBeGreaterThan(0)
    expect(pkg!.commits).toBeGreaterThanOrEqual(1)
    expect(sig.shard.churn['package.json']).toBe(pkg!.commits)

    // churn keys sorted (determinism)
    const keys = Object.keys(sig.shard.churn)
    expect(keys).toEqual([...keys].sort())
  })

  it('ignores files outside knownFiles', () => {
    const sig = collectGitSignals(repoRoot, DEFAULT_CONFIG, new Set(['package.json']))
    expect(Object.keys(sig.shard.churn)).toEqual(['package.json'])
    expect(sig.shard.recent.every((r) => r.f === 'package.json')).toBe(true)
  })

  it('cochange partners require count >= 2', () => {
    const sig = collectGitSignals(
      repoRoot,
      DEFAULT_CONFIG,
      new Set(['package.json', 'src/core/types.ts']),
    )
    for (const partners of Object.values(sig.shard.cochange)) {
      expect(partners.length).toBeLessThanOrEqual(10)
      for (const [, count] of partners) expect(count).toBeGreaterThanOrEqual(2)
    }
  })

  it('is deterministic across calls', () => {
    const known = new Set(['package.json', 'src/core/types.ts'])
    const a = collectGitSignals(repoRoot, DEFAULT_CONFIG, known)
    const b = collectGitSignals(repoRoot, DEFAULT_CONFIG, known)
    expect(JSON.stringify(a.shard)).toBe(JSON.stringify(b.shard))
  })

  it('returns empty signals for a non-git dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
    const sig = collectGitSignals(dir, DEFAULT_CONFIG, new Set(['a.ts']))
    expect(sig.shard).toEqual({ recent: [], churn: {}, cochange: {} })
    expect(sig.perFile.size).toBe(0)
  })
})

describe('headCommit', () => {
  it('returns a 40-hex hash for this repo', () => {
    expect(headCommit(repoRoot)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('returns null for a non-git dir', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
    expect(headCommit(dir)).toBeNull()
  })
})
