import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CtxConfig } from '../../src/core/types'
import { DEFAULT_CONFIG } from '../../src/core/config'
import { detectLang, isBinaryBuffer, scanRepo } from '../../src/core/indexer/scan'

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url))

function makeCfg(over: Partial<CtxConfig> = {}): CtxConfig {
  return { ...DEFAULT_CONFIG, ...over }
}

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

let hasGit = false
try {
  execFileSync('git', ['--version'])
  hasGit = true
} catch {
  hasGit = false
}

describe('scanRepo (walk mode)', () => {
  it('enumerates the ts-app fixture without a .git dir', () => {
    const root = path.join(FIXTURES, 'ts-app')
    const res = scanRepo(root, makeCfg())
    expect(res.isGit).toBe(false)
    const rels = res.files.map((f) => f.rel)
    expect(rels).toContain('src/index.ts')
    expect(rels).toContain('package.json')
    expect(rels).toContain('.github/workflows/ci.yml')
    for (const f of res.files) {
      expect(f.abs).toBe(path.join(root, f.rel))
      expect(f.size).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(f.mtime)).toBe(true)
      expect(f.mtime).toBeGreaterThan(0)
    }
  })

  it('excludes .gitignored dist/bundle.js but includes .env', () => {
    const res = scanRepo(path.join(FIXTURES, 'ts-app'), makeCfg())
    const rels = res.files.map((f) => f.rel)
    expect(rels).not.toContain('dist/bundle.js')
    expect(rels).toContain('.env')
  })

  it('is deterministic and sorted by rel path', () => {
    const root = path.join(FIXTURES, 'ts-app')
    const a = scanRepo(root, makeCfg())
    const b = scanRepo(root, makeCfg())
    expect(a.files.map((f) => f.rel)).toEqual([...a.files.map((f) => f.rel)].sort())
    expect(a).toEqual(b)
  })

  it('skips symlinks and counts them', () => {
    const root = tmpRepo()
    write(root, 'a.txt', 'hello')
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'))
    const res = scanRepo(root, makeCfg())
    expect(res.files.map((f) => f.rel)).toEqual(['a.txt'])
    expect(res.skippedCount).toBe(1)
  })

  it('skips files over maxFileSizeKb and counts them', () => {
    const root = tmpRepo()
    write(root, 'small.txt', 'x')
    write(root, 'big.txt', 'y'.repeat(2048))
    const res = scanRepo(root, makeCfg({ maxFileSizeKb: 1 }))
    expect(res.files.map((f) => f.rel)).toEqual(['small.txt'])
    expect(res.skippedCount).toBe(1)
  })

  it('stops at maxFiles and counts the remainder', () => {
    const root = tmpRepo()
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(root, n, n)
    const res = scanRepo(root, makeCfg({ maxFiles: 2 }))
    expect(res.files.map((f) => f.rel)).toEqual(['a.txt', 'b.txt'])
    expect(res.skippedCount).toBe(2)
  })

  it('hard-excludes node_modules and .claude-ctx', () => {
    const root = tmpRepo()
    write(root, 'src/a.ts', 'x')
    write(root, 'node_modules/dep/index.js', 'x')
    write(root, '.claude-ctx/cache.json', '{}')
    const res = scanRepo(root, makeCfg())
    expect(res.files.map((f) => f.rel)).toEqual(['src/a.ts'])
    expect(res.skippedCount).toBe(2)
  })

  it('excludes target only when a Cargo.toml is present', () => {
    const withCargo = tmpRepo()
    write(withCargo, 'Cargo.toml', '[package]\nname = "x"\n')
    write(withCargo, 'target/debug/bin', 'x')
    const a = scanRepo(withCargo, makeCfg())
    expect(a.files.map((f) => f.rel)).toEqual(['Cargo.toml'])
    expect(a.skippedCount).toBe(1)

    const noCargo = tmpRepo()
    write(noCargo, 'target/notes.txt', 'x')
    const b = scanRepo(noCargo, makeCfg())
    expect(b.files.map((f) => f.rel)).toEqual(['target/notes.txt'])
  })

  it('applies nested .gitignore with negation (last match wins)', () => {
    const root = tmpRepo()
    write(root, '.gitignore', '*.log\n')
    write(root, 'a.log', 'x')
    write(root, 'sub/.gitignore', '!keep.log\n')
    write(root, 'sub/keep.log', 'x')
    write(root, 'sub/other.log', 'x')
    const res = scanRepo(root, makeCfg())
    const rels = res.files.map((f) => f.rel)
    expect(rels).not.toContain('a.log')
    expect(rels).not.toContain('sub/other.log')
    expect(rels).toContain('sub/keep.log')
  })

  it('applies cfg.exclude globs and counts skips', () => {
    const root = tmpRepo()
    write(root, 'a.ts', 'x')
    write(root, 'snap/x.snap', 'x')
    const res = scanRepo(root, makeCfg({ exclude: ['**/*.snap'] }))
    expect(res.files.map((f) => f.rel)).toEqual(['a.ts'])
    expect(res.skippedCount).toBe(1)
  })
})

describe('scanRepo (git mode)', () => {
  it.runIf(hasGit)('uses git ls-files: gitignore honored, untracked unignored included', () => {
    const root = tmpRepo()
    execFileSync('git', ['init', '-q'], { cwd: root })
    write(root, '.gitignore', 'dist\n')
    write(root, 'src/index.ts', 'x')
    write(root, '.env', 'KEY=1')
    write(root, 'dist/bundle.js', 'x')
    write(root, 'node_modules/dep/index.js', 'x')
    const res = scanRepo(root, makeCfg())
    expect(res.isGit).toBe(true)
    const rels = res.files.map((f) => f.rel)
    expect(rels).toContain('src/index.ts')
    expect(rels).toContain('.env')
    expect(rels).toContain('.gitignore')
    expect(rels).not.toContain('dist/bundle.js')
    expect(rels.some((r) => r.startsWith('node_modules/'))).toBe(false)
    expect(res.skippedCount).toBeGreaterThanOrEqual(1) // node_modules hard exclude
    expect(rels).toEqual([...rels].sort())
  })
})

describe('isBinaryBuffer', () => {
  it('detects NUL bytes in the first 8KiB', () => {
    expect(isBinaryBuffer(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
    expect(isBinaryBuffer(Buffer.from('plain text\nwith lines\n'))).toBe(false)
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false)
    const lateNul = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0x00])])
    expect(isBinaryBuffer(lateNul)).toBe(false)
  })
})

describe('detectLang', () => {
  it('maps extensions to Lang', () => {
    expect(detectLang('src/a.ts')).toBe('ts')
    expect(detectLang('src/a.tsx')).toBe('ts')
    expect(detectLang('a.mts')).toBe('ts')
    expect(detectLang('a.cts')).toBe('ts')
    expect(detectLang('a.js')).toBe('js')
    expect(detectLang('a.jsx')).toBe('js')
    expect(detectLang('a.mjs')).toBe('js')
    expect(detectLang('a.cjs')).toBe('js')
    expect(detectLang('src/lib.rs')).toBe('rust')
    expect(detectLang('README.md')).toBe('md')
    expect(detectLang('doc.markdown')).toBe('md')
    expect(detectLang('package.json')).toBe('json')
    expect(detectLang('Cargo.toml')).toBe('toml')
    expect(detectLang('ci.yaml')).toBe('yaml')
    expect(detectLang('ci.yml')).toBe('yaml')
    expect(detectLang('Dockerfile')).toBe('other')
    expect(detectLang('a/b.SQL')).toBe('other')
    expect(detectLang('UPPER.TS')).toBe('ts')
  })
})
