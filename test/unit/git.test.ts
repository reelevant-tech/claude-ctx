import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  branchKeyFromHead,
  currentBranchKey,
  discoverRepos,
  gitTopLevel,
  readHead,
  resolveGitDir,
  sanitizeBranch,
} from '../../src/core/git'

const FIX = join(__dirname, '..', '..', 'fixtures')

function gitInit(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' })
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ctx-git-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('branchKey derivation', () => {
  it('sanitizes branch names with slashes/spaces/unicode into a safe segment', () => {
    expect(sanitizeBranch('feature/auth')).toBe('feature-auth')
    expect(sanitizeBranch('feature/é app')).toContain('feature')
    expect(sanitizeBranch('feature/é app')).not.toContain('/')
    expect(sanitizeBranch('feature/é app')).not.toContain(' ')
  })

  it('branchKey = sanitized + short hash; distinguishes collision-prone names', () => {
    const a = branchKeyFromHead({ branch: 'feature/auth' })
    const b = branchKeyFromHead({ branch: 'feature-auth' })
    expect(a.startsWith('feature-auth-')).toBe(true)
    expect(a).not.toBe(b) // different raw names -> different hash suffix
  })

  it('detached HEAD -> deterministic detached-<short>', () => {
    expect(branchKeyFromHead({ commit: 'abcdef1234567890abcdef1234567890abcdef12' })).toBe('detached-abcdef123456')
  })

  it('unknown git state -> "unknown"', () => {
    expect(branchKeyFromHead(null)).toBe('unknown')
    expect(branchKeyFromHead({})).toBe('unknown')
  })
})

describe('readHead / resolveGitDir (file-based)', () => {
  it('reads the current branch from .git/HEAD without spawning git', () => {
    gitInit(tmp, 'my/feature')
    expect(resolveGitDir(tmp)).toBe(join(tmp, '.git'))
    expect(readHead(tmp)?.branch).toBe('my/feature')
    expect(currentBranchKey(tmp).startsWith('my-feature-')).toBe(true)
  })

  it('returns null for a non-git dir', () => {
    expect(resolveGitDir(tmp)).toBeNull()
    expect(readHead(tmp)).toBeNull()
    expect(currentBranchKey(tmp)).toBe('unknown')
  })
})

describe('gitTopLevel', () => {
  it('resolves the repo root from a nested subdir, not the cwd', () => {
    gitInit(tmp)
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    const top = gitTopLevel(join(tmp, 'a', 'b'))
    // realpath on macOS may prefix /private; compare basenames + endsWith
    expect(top).toBeTruthy()
    expect(top!.endsWith(tmp.split('/').pop()!)).toBe(true)
  })
  it('returns null outside any repo', () => {
    expect(gitTopLevel(tmp)).toBeNull()
  })
})

describe('discoverRepos', () => {
  it('finds multiple repos under a workspace and excludes the workspace itself', () => {
    const ws = join(tmp, 'workspace')
    mkdirSync(join(ws, 'repoA'), { recursive: true })
    mkdirSync(join(ws, 'repoB'), { recursive: true })
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true }) // must be skipped
    gitInit(join(ws, 'repoA'))
    gitInit(join(ws, 'repoB'))
    gitInit(join(ws, 'node_modules', 'pkg')) // inside excluded dir -> must NOT be discovered
    const repos = discoverRepos(ws)
    expect(repos.some((r) => r.endsWith('/repoA'))).toBe(true)
    expect(repos.some((r) => r.endsWith('/repoB'))).toBe(true)
    expect(repos.some((r) => r.includes('node_modules'))).toBe(false)
    expect(repos.some((r) => r === ws || r.endsWith('/workspace'))).toBe(false) // workspace not a repo
  })

  it('treats nested repos/submodules as independent repos', () => {
    const ws = join(tmp, 'ws')
    mkdirSync(join(ws, 'outer', 'inner'), { recursive: true })
    gitInit(join(ws, 'outer'))
    gitInit(join(ws, 'outer', 'inner'))
    const repos = discoverRepos(ws)
    expect(repos.some((r) => r.endsWith('/outer'))).toBe(true)
    expect(repos.some((r) => r.endsWith('/outer/inner'))).toBe(true)
  })

  it('discovers a copied fixture repo', () => {
    const ws = join(tmp, 'ws2')
    mkdirSync(ws, { recursive: true })
    cpSync(join(FIX, 'rust-single'), join(ws, 'rust-single'), { recursive: true })
    gitInit(join(ws, 'rust-single'))
    writeFileSync(join(ws, 'README.md'), '# not a repo\n')
    const repos = discoverRepos(ws)
    expect(repos).toHaveLength(1)
    expect(repos[0]!.endsWith('/rust-single')).toBe(true)
  })
})
