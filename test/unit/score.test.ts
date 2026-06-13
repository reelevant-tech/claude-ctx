import { describe, expect, it } from 'vitest'
import { scoreFiles } from '../../src/core/router/score'
import { tokenizeTask } from '../../src/core/tokens'
import type {
  FileRecord,
  GraphShard,
  LoadedIndex,
  SessionState,
  SymbolRecord,
} from '../../src/core/types'

const NOW = 1_750_000_000
const DAY = 86400

function fr(p: Partial<FileRecord>): FileRecord {
  return {
    h: 'abc123def456',
    mtime: NOW - 100 * DAY,
    size: 1000,
    lines: 100,
    lang: 'ts',
    pkg: 0,
    parser: 'ts-api',
    kind: 'source',
    risk: [],
    entry: false,
    exports: [],
    externalDeps: [],
    docHeadings: [],
    tests: [],
    ...p,
  }
}

function makeIndex(): LoadedIndex {
  const files: Record<string, FileRecord> = {
    'src/billing/invoice.ts': fr({
      exports: ['createInvoice', 'Invoice'],
      git: { lastTs: NOW - 2 * DAY, commits: 5 },
      tests: ['src/billing/invoice.test.ts'],
    }),
    'src/billing/customer.ts': fr({
      exports: ['Customer'],
      git: { lastTs: NOW - 60 * DAY, commits: 1 },
    }),
    'src/api/billing.ts': fr({ exports: ['billingRouter'], entry: true }),
    'src/billing/invoice.test.ts': fr({
      kind: 'test',
      testedBy: 'src/billing/invoice.ts',
      git: { lastTs: NOW - 1 * DAY, commits: 2 },
    }),
    'dist/gen.js': fr({
      kind: 'generated',
      risk: ['generated'],
      exports: ['createInvoice'],
      pkg: -1,
      lang: 'js',
      parser: 'lexical',
    }),
    Dockerfile: fr({ kind: 'infra', risk: ['infra'], pkg: -1, lang: 'other', parser: 'none' }),
    'README.md': fr({
      kind: 'doc',
      lang: 'md',
      parser: 'lexical',
      pkg: -1,
      docHeadings: ['Billing pipeline'],
    }),
    'src/util/format.ts': fr({ exports: ['formatDate', 'formatMoney'] }),
    'src/core/db.ts': fr({ exports: ['query', 'connect'] }),
  }
  const symbols: SymbolRecord[] = [
    { n: 'createInvoice', k: 'fn', f: 'src/billing/invoice.ts', l: 42, x: true, sig: 'export function createInvoice(c: Customer): Invoice' },
    { n: 'Invoice', k: 'iface', f: 'src/billing/invoice.ts', l: 10, x: true, sig: 'export interface Invoice' },
    { n: 'Customer', k: 'iface', f: 'src/billing/customer.ts', l: 3, x: true, sig: 'export interface Customer' },
    { n: 'billingRouter', k: 'const', f: 'src/api/billing.ts', l: 8, x: true, sig: 'export const billingRouter = router()' },
    { n: 'formatDate', k: 'fn', f: 'src/util/format.ts', l: 2, x: true, sig: 'export function formatDate(d: Date): string' },
    { n: 'formatMoney', k: 'fn', f: 'src/util/format.ts', l: 9, x: true, sig: 'export function formatMoney(cents: number): string' },
    { n: 'query', k: 'fn', f: 'src/core/db.ts', l: 5, x: true, sig: 'export function query(sql: string): Promise<Row[]>' },
    { n: 'connect', k: 'fn', f: 'src/core/db.ts', l: 1, x: true, sig: 'export function connect(): Db' },
  ]
  const graph: GraphShard = {
    fwd: {
      'src/api/billing.ts': ['src/billing/invoice.ts', 'src/core/db.ts'],
      'src/billing/invoice.ts': ['src/billing/customer.ts', 'src/core/db.ts'],
      'src/billing/invoice.test.ts': ['src/billing/invoice.ts'],
    },
    rev: {
      'src/billing/invoice.ts': ['src/api/billing.ts', 'src/billing/invoice.test.ts'],
      'src/billing/customer.ts': ['src/billing/invoice.ts'],
      'src/core/db.ts': ['src/api/billing.ts', 'src/billing/invoice.ts'],
    },
    centrality: { 'src/billing/invoice.ts': 2, 'src/billing/customer.ts': 1, 'src/core/db.ts': 12 },
  }
  return {
    meta: {
      version: 1,
      root: '/repo/fake',
      repoId: 'fake-abcdef123456',
      indexedAt: NOW,
      indexDurationMs: 10,
      fileCount: Object.keys(files).length,
      skippedCount: 0,
      isGit: true,
      projectType: 'ts-app',
      packages: [
        { id: 0, name: 'app', dir: '', kind: 'npm', manifest: 'package.json', entrypoints: ['src/index.ts'] },
      ],
      treeSummary: 'src/\n  api/\n  billing/\n  core/\n  util/\ndist/\nREADME.md\nDockerfile',
      riskyGlobs: [],
      secretGlobs: [],
    },
    files: { files },
    symbols: { symbols, tokenIndex: {} },
    graph,
    git: {
      recent: [],
      churn: {},
      cochange: {
        'src/billing/invoice.ts': [['src/api/billing.ts', 4]],
        'src/api/billing.ts': [['src/billing/invoice.ts', 4]],
      },
    },
    commands: {
      commands: [
        { cmd: 'pnpm test', src: 'package.json:scripts.test', kind: 'test' },
        { cmd: 'pnpm build', src: 'package.json:scripts.build', kind: 'build' },
        { cmd: 'pnpm lint', src: 'package.json:scripts.lint', kind: 'lint' },
      ],
    },
  }
}

const idx = makeIndex()
const toks = (s: string) => tokenizeTask(s)

describe('scoreFiles', () => {
  it('ranks billing/invoice.ts #1 for the invoice task, mentioning the symbol', () => {
    const res = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    expect(res[0]?.path).toBe('src/billing/invoice.ts')
    expect(res[0]?.reasons.some((r) => r.reason.includes('createInvoice'))).toBe(true)
  })

  it('penalizes generated files below the cutoff on unrelated tasks', () => {
    const res = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    expect(res.some((r) => r.path === 'dist/gen.js')).toBe(false)
  })

  it('waives the infra penalty for risk-domain tasks and surfaces Dockerfile', () => {
    const res = scoreFiles(toks('update docker deploy workflow'), idx, null, NOW)
    const docker = res.find((r) => r.path === 'Dockerfile')
    expect(docker).toBeDefined()
    expect(docker?.reasons.some((r) => r.reason === 'infra file')).toBe(false)
    expect(docker?.score).toBe(100)
  })

  it('is deterministic: two runs produce deep-equal results', () => {
    const a = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    const b = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    expect(b).toEqual(a)
  })

  it('lifts the test file via the test-link boost when its source is top', () => {
    const res = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    const t = res.find((r) => r.path === 'src/billing/invoice.test.ts')
    expect(t).toBeDefined()
    expect(t?.reasons.some((r) => r.reason === 'test of src/billing/invoice.ts')).toBe(true)
  })

  it('adds recency and centrality reasons', () => {
    const res = scoreFiles(toks('fix invoice rounding in createInvoice'), idx, null, NOW)
    expect(res[0]?.reasons.some((r) => r.reason === 'changed 2d ago')).toBe(true)
    const db = scoreFiles(toks('optimize db query connection pool'), idx, null, NOW)
    expect(db[0]?.path).toBe('src/core/db.ts')
    expect(db[0]?.reasons.some((r) => r.reason === 'imported by 12 files')).toBe(true)
  })

  it('adds the cochange boost when the partner is in the provisional top-5', () => {
    const res = scoreFiles(toks('billing invoice api'), idx, null, NOW)
    const api = res.find((r) => r.path === 'src/api/billing.ts')
    expect(api?.reasons.some((r) => r.reason === 'co-changes with src/billing/invoice.ts')).toBe(
      true,
    )
  })

  it('boosts files already inspected in the session', () => {
    const state: SessionState = {
      reads: { 'src/billing/customer.ts': 2 },
      edits: [],
      testsReminded: [],
      updatedAt: NOW,
    }
    const res = scoreFiles(toks('customer rounding logic'), idx, state, NOW)
    expect(res[0]?.path).toBe('src/billing/customer.ts')
    expect(res[0]?.reasons.some((r) => r.reason === 'already inspected this session')).toBe(true)
  })

  it('sorts desc, rounds to 1 decimal, applies cutoff and cap', () => {
    const res = scoreFiles(toks('billing invoice api'), idx, null, NOW)
    expect(res.length).toBeGreaterThan(1)
    for (let i = 1; i < res.length; i++) {
      const prev = res[i - 1]
      const cur = res[i]
      expect(cur && prev && cur.score <= prev.score).toBe(true)
    }
    expect(res.every((r) => r.score >= 25)).toBe(true)
    expect(res.every((r) => Math.abs(r.score * 10 - Math.round(r.score * 10)) < 1e-6)).toBe(true)
    expect(res.length).toBeLessThanOrEqual(40)
  })

  it('returns empty for empty token lists', () => {
    expect(scoreFiles([], idx, null, NOW)).toEqual([])
  })
})
