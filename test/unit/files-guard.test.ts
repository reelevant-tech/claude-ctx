import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/config'
import { classifyEditTarget, isSecretTarget, readWarning } from '../../src/core/guard/files'
import type { FileRecord } from '../../src/core/types'

function rec(over: Partial<FileRecord> = {}): FileRecord {
  return {
    h: 'abc123def456',
    mtime: 0,
    size: 100,
    lines: 10,
    lang: 'ts',
    pkg: -1,
    parser: 'ts-api',
    kind: 'source',
    risk: [],
    entry: false,
    exports: [],
    externalDeps: [],
    docHeadings: [],
    tests: [],
    ...over,
  }
}

const cfg = DEFAULT_CONFIG

describe('classifyEditTarget', () => {
  it('flags secret basenames without a record', () => {
    const v = classifyEditTarget('.env', null, cfg)
    expect(v).toEqual({ tier: 'severe', rule: 'edit-secret', reason: 'credentials file' })
  })

  it('flags nested secret basenames', () => {
    expect(classifyEditTarget('config/.env.local', null, cfg)?.rule).toBe('edit-secret')
    expect(classifyEditTarget('keys/server.pem', null, cfg)?.rule).toBe('edit-secret')
  })

  it('flags record kind secret regardless of path', () => {
    const v = classifyEditTarget('config/creds.yaml', rec({ kind: 'secret' }), cfg)
    expect(v?.tier).toBe('severe')
    expect(v?.rule).toBe('edit-secret')
  })

  it('uses cfg.secretGlobs', () => {
    const c = { ...DEFAULT_CONFIG, secretGlobs: ['config/secrets/**'] }
    expect(classifyEditTarget('config/secrets/prod.yaml', null, c)?.rule).toBe('edit-secret')
  })

  it('secret wins over generated', () => {
    const v = classifyEditTarget('dist/x.js', rec({ kind: 'secret' }), cfg)
    expect(v?.rule).toBe('edit-secret')
  })

  it('flags generated paths', () => {
    const v = classifyEditTarget('dist/index.js', null, cfg)
    expect(v?.tier).toBe('destructive')
    expect(v?.rule).toBe('edit-generated')
    expect(v?.reason).toContain('edit the source generator')
  })

  it('flags lockfiles as generated', () => {
    expect(classifyEditTarget('package-lock.json', null, cfg)?.rule).toBe('edit-generated')
  })

  it('flags record kind/risk generated', () => {
    expect(classifyEditTarget('gen/api.ts', rec({ kind: 'generated' }), cfg)?.rule).toBe(
      'edit-generated',
    )
    expect(classifyEditTarget('gen/api.ts', rec({ risk: ['generated'] }), cfg)?.rule).toBe(
      'edit-generated',
    )
  })

  it('flags vendor paths and records', () => {
    const v = classifyEditTarget('node_modules/lodash/index.js', null, cfg)
    expect(v?.tier).toBe('destructive')
    expect(v?.rule).toBe('edit-vendor')
    expect(classifyEditTarget('lib/blob.js', rec({ kind: 'vendor' }), cfg)?.rule).toBe(
      'edit-vendor',
    )
  })

  it('flags infra globs with the matching rule in the reason', () => {
    const v = classifyEditTarget('Dockerfile', null, cfg)
    expect(v?.tier).toBe('destructive')
    expect(v?.rule).toBe('edit-infra')
    expect(v?.reason).toContain('production-sensitive file')
    expect(classifyEditTarget('.github/workflows/ci.yml', null, cfg)?.rule).toBe('edit-infra')
  })

  it('flags record risk infra', () => {
    const v = classifyEditTarget('deploy.sh', rec({ risk: ['infra'] }), cfg)
    expect(v?.rule).toBe('edit-infra')
    expect(v?.reason).toContain('risk tag')
  })

  it('uses cfg.riskyGlobs', () => {
    const c = { ...DEFAULT_CONFIG, riskyGlobs: ['ops/**'] }
    const v = classifyEditTarget('ops/prod.sh', null, c)
    expect(v?.rule).toBe('edit-infra')
    expect(v?.reason).toContain('riskyGlobs')
  })

  it('returns null for plain source files', () => {
    expect(classifyEditTarget('src/app.ts', rec(), cfg)).toBeNull()
    expect(classifyEditTarget('src/billing/invoice.ts', null, cfg)).toBeNull()
  })
})

describe('isSecretTarget', () => {
  it('is true for secret basenames, records, and secretGlobs — the read guard shares this', () => {
    expect(isSecretTarget('.env', null, cfg)).toBe(true)
    expect(isSecretTarget('config/.env.local', null, cfg)).toBe(true)
    expect(isSecretTarget('keys/server.pem', null, cfg)).toBe(true)
    expect(isSecretTarget('config/creds.yaml', rec({ kind: 'secret' }), cfg)).toBe(true)
    const c = { ...DEFAULT_CONFIG, secretGlobs: ['config/secrets/**'] }
    expect(isSecretTarget('config/secrets/prod.yaml', null, c)).toBe(true)
  })

  it('is false for ordinary source files', () => {
    expect(isSecretTarget('src/app.ts', rec(), cfg)).toBe(false)
    expect(isSecretTarget('README.md', null, cfg)).toBe(false)
  })
})

describe('readWarning', () => {
  it('flags generated paths as low-value', () => {
    expect(readWarning('dist/a.js', null, 0)).toBe(
      'low-value read: generated file — usually safe to skip',
    )
    expect(readWarning('yarn.lock', null, 0)).toContain('low-value read')
  })

  it('flags vendor records as low-value', () => {
    expect(readWarning('lib/x.js', rec({ kind: 'vendor' }), 0)).toContain('low-value read')
  })

  it('warns on huge files with the line count', () => {
    expect(readWarning('src/big.ts', rec({ lines: 5000 }), 0)).toBe(
      'huge file (5000 lines) — consider mcp__ctx__symbol_search to find the relevant section',
    )
  })

  it('warns on repeated reads', () => {
    expect(readWarning('src/app.ts', rec(), 2)).toBe(
      'already read 2 times this session — content unchanged unless edited',
    )
    expect(readWarning('src/app.ts', null, 3)).toContain('already read 3 times')
  })

  it('generated beats huge, huge beats repeat-read', () => {
    expect(readWarning('dist/a.js', rec({ kind: 'generated', lines: 9000 }), 5)).toContain(
      'low-value read',
    )
    expect(readWarning('src/big.ts', rec({ lines: 4000 }), 5)).toContain('huge file (4000 lines)')
  })

  it('returns null for normal reads', () => {
    expect(readWarning('src/app.ts', rec({ lines: 100 }), 1)).toBeNull()
    expect(readWarning('src/app.ts', null, 0)).toBeNull()
  })
})
