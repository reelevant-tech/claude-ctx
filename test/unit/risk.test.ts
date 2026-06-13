import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/config'
import { classifyRisk, isSecretPath } from '../../src/core/indexer/risk'
import type { CtxConfig, FileKind, RiskTag } from '../../src/core/types'

const cfg = (over: Partial<CtxConfig> = {}): CtxConfig => ({ ...DEFAULT_CONFIG, ...over })

describe('classifyRisk', () => {
  const cases: [string, FileKind | null, RiskTag[]][] = [
    ['.env', 'secret', ['secret']],
    ['config/.env.local', 'secret', ['secret']],
    ['certs/server.pem', 'secret', ['secret']],
    ['keys/id_rsa', 'secret', ['secret']],
    ['.npmrc', 'secret', ['secret']],
    ['terraform/prod.tfvars', 'secret', ['secret']], // secret beats infra
    ['gcp/service-account-prod.json', 'secret', ['secret']],
    ['dist/x.js', 'generated', ['generated']],
    ['src/api/client.gen.ts', 'generated', ['generated']],
    ['pnpm-lock.yaml', 'generated', ['generated']],
    ['assets/app.min.js', 'generated', ['generated']],
    ['src/__snapshots__/a.test.ts.snap', 'generated', ['generated']],
    ['vendor/lib.js', 'vendor', ['vendor']],
    ['third_party/zlib/inflate.c', 'vendor', ['vendor']],
    ['Dockerfile', 'infra', ['infra']],
    ['docker-compose.yml', 'infra', ['infra']],
    ['.github/workflows/ci.yml', 'infra', ['infra']],
    ['migrations/001.sql', 'infra', ['infra']],
    ['infra/main.tf', 'infra', ['infra']],
    ['Jenkinsfile', 'infra', ['infra']],
    ['src/app.ts', null, []],
    ['README.md', null, []],
  ]

  for (const [rel, kind, risk] of cases) {
    it(`${rel} -> ${kind ?? 'null'}`, () => {
      expect(classifyRisk(rel, cfg())).toEqual({ kind, risk })
    })
  }

  it('cfg.riskyGlobs extension classifies as infra', () => {
    const c = cfg({ riskyGlobs: ['src/billing/**'] })
    expect(classifyRisk('src/billing/charge.ts', c)).toEqual({ kind: 'infra', risk: ['infra'] })
    expect(classifyRisk('src/app.ts', c)).toEqual({ kind: null, risk: [] })
  })

  it('cfg.secretGlobs extend the built-in secret set', () => {
    const c = cfg({ secretGlobs: ['**/*.token'] })
    expect(classifyRisk('auth/api.token', c)).toEqual({ kind: 'secret', risk: ['secret'] })
  })

  it('built-in secret wins over generated even inside dist', () => {
    expect(classifyRisk('dist/.env', cfg())).toEqual({ kind: 'secret', risk: ['secret'] })
  })
})

describe('isSecretPath', () => {
  it('matches built-ins', () => {
    expect(isSecretPath('.env', [])).toBe(true)
    expect(isSecretPath('nested/dir/.env.production', [])).toBe(true)
    expect(isSecretPath('src/app.ts', [])).toBe(false)
  })

  it('matches extra globs', () => {
    expect(isSecretPath('custom/key.token', ['**/*.token'])).toBe(true)
    expect(isSecretPath('custom/key.token', [])).toBe(false)
  })
})
