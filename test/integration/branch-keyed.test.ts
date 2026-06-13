import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/core/config'
import { buildVectors } from '../../src/core/embed/build'
import { semanticScores } from '../../src/core/embed/query'
import { createStubEmbedder } from '../../src/core/embed/stub'
import { currentBranchKey } from '../../src/core/git'
import { buildIndex } from '../../src/core/indexer/index'
import { branchDir, indexDir, legacyIndexDir } from '../../src/core/paths'
import { loadMeta, loadShard, saveShard } from '../../src/core/store/shards'
import type { VectorsShard } from '../../src/core/types'

const FIX = join(__dirname, '..', '..', 'fixtures')

function setupRepo(fixture: string, branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-bk-'))
  cpSync(join(FIX, fixture), dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: dir, stdio: 'ignore' },
  )
  return dir
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-bkhome-'))
  process.env.CLAUDE_CTX_HOME = home
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('branch-keyed layout', () => {
  it('writes the index under branches/<branchKey>/index and stamps identity', async () => {
    const repo = setupRepo('ts-app', 'main')
    try {
      await buildIndex(repo, { mode: 'full' })
      const bk = currentBranchKey(repo)
      expect(indexDir(repo)).toBe(join(branchDir(repo, bk), 'index'))
      expect(existsSync(join(branchDir(repo, bk), 'index', 'meta.json'))).toBe(true)
      const meta = loadMeta(repo)!
      expect(meta.repo?.repoName).toBe(require('node:path').basename(require('node:fs').realpathSync(repo)))
      expect(meta.gitId?.branch).toBe('main')
      expect(meta.gitId?.branchKey).toBe(bk)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('switching branch uses a different index directory', async () => {
    const repo = setupRepo('ts-app', 'main')
    try {
      await buildIndex(repo, { mode: 'full' })
      const mainBk = currentBranchKey(repo)
      execFileSync('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: repo, stdio: 'ignore' })
      const featBk = currentBranchKey(repo)
      expect(featBk).not.toBe(mainBk)
      await buildIndex(repo, { mode: 'full' })
      // both branch index dirs exist independently
      expect(existsSync(join(branchDir(repo, mainBk), 'index', 'meta.json'))).toBe(true)
      expect(existsSync(join(branchDir(repo, featBk), 'index', 'meta.json'))).toBe(true)
      expect(loadMeta(repo)!.gitId?.branch).toBe('feature/x')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not leave a legacy (non-branch) index dir', async () => {
    const repo = setupRepo('ts-app', 'main')
    try {
      await buildIndex(repo, { mode: 'full' })
      expect(existsSync(legacyIndexDir(repo))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('vector query guards', () => {
  async function buildStubVectors(repo: string) {
    await buildIndex(repo, { mode: 'full' })
    const cfg = loadConfig(repo)
    const stub = createStubEmbedder(64)
    await buildVectors(repo, cfg, { embedder: stub })
    return { cfg, stub }
  }

  it('queries successfully when repo/branch/model/dim all match', async () => {
    const repo = setupRepo('ts-app')
    try {
      const { cfg, stub } = await buildStubVectors(repo)
      const hit = await semanticScores(repo, 'create invoice', cfg, stub)
      expect(hit).toBeTruthy()
      expect(hit!.scores.size).toBeGreaterThan(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a different model', async () => {
    const repo = setupRepo('ts-app')
    try {
      const { cfg } = await buildStubVectors(repo)
      const other = { model: 'other-model', dim: 64, embed: createStubEmbedder(64).embed }
      expect(await semanticScores(repo, 'x', cfg, other)).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a different dimension', async () => {
    const repo = setupRepo('ts-app')
    try {
      const { cfg } = await buildStubVectors(repo)
      const wrongDim = { model: 'stub', dim: 32, embed: createStubEmbedder(32).embed }
      expect(await semanticScores(repo, 'x', cfg, wrongDim)).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a wrong repoId (tampered shard)', async () => {
    const repo = setupRepo('ts-app')
    try {
      const { cfg, stub } = await buildStubVectors(repo)
      const shard = loadShard<VectorsShard>(repo, 'vectors')!
      shard.repo!.repoId = 'someone-else'
      saveShard(repo, 'vectors', shard)
      expect(await semanticScores(repo, 'x', cfg, stub)).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a wrong branchKey (tampered shard)', async () => {
    const repo = setupRepo('ts-app')
    try {
      const { cfg, stub } = await buildStubVectors(repo)
      const shard = loadShard<VectorsShard>(repo, 'vectors')!
      shard.gitId!.branchKey = 'other-branch-key'
      saveShard(repo, 'vectors', shard)
      expect(await semanticScores(repo, 'x', cfg, stub)).toBeUndefined()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('dirty worktree', () => {
  it('still indexes and queries (freshness is by hash, not dirty flag)', async () => {
    const repo = setupRepo('ts-app')
    try {
      // make the worktree dirty
      writeFileSync(join(repo, 'src/billing/invoice.ts'), '\nexport function extra() {}\n', { flag: 'a' })
      const stats = await buildIndex(repo, { mode: 'full' })
      expect(stats.mode).toBe('full')
      expect(loadMeta(repo)!.gitId?.dirty).toBe(true)
      const cfg = loadConfig(repo)
      const stub = createStubEmbedder(64)
      await buildVectors(repo, cfg, { embedder: stub })
      const hit = await semanticScores(repo, 'invoice', cfg, stub)
      expect(hit).toBeTruthy()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
