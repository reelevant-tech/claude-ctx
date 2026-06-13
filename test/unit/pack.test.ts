import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPack } from '../../src/core/router/pack'
import { renderOverview, renderPack } from '../../src/core/router/render'
import { estimateTokens } from '../../src/core/tokens'
import type {
  FileRecord,
  GraphShard,
  LoadedIndex,
  RepoSummary,
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
const TASK = 'fix invoice rounding in createInvoice'

describe('buildPack', () => {
  it('builds a high-confidence pack with files, deps and symbols', () => {
    const pack = buildPack(TASK, idx, null, { budget: 1500, nowSec: NOW })
    expect(pack.confidence).toBe('high')
    expect(pack.files[0]?.path).toBe('src/billing/invoice.ts')
    expect(pack.files[0]?.why.join(' ')).toContain('createInvoice')
    expect(pack.files[0]?.tests).toContain('src/billing/invoice.test.ts')
    expect(pack.depLinks).toContain('src/billing/invoice.test.ts → src/billing/invoice.ts')
    expect(pack.files[0]?.symbols[0]).toContain('createInvoice')
    expect(pack.files[0]?.symbols[0]).toContain('[src/billing/invoice.ts:42]')
  })

  it('reports medium confidence with a nextStep for partial matches', () => {
    const pack = buildPack('customer rounding logic', idx, null, { budget: 1500, nowSec: NOW })
    expect(pack.confidence).toBe('medium')
    expect(pack.nextStep).toContain("mcp__ctx__symbol_search('rounding')")
  })

  it('reports low confidence with missing for unmatched tasks', () => {
    const pack = buildPack('zzqq blorp wibble', idx, null, { budget: 1500, nowSec: NOW })
    expect(pack.confidence).toBe('low')
    expect(pack.files).toEqual([])
    expect(pack.missing).toContain('No strong match for:')
    expect(pack.missing).toContain('blorp')
    expect(pack.nextStep).toContain('mcp__ctx__symbol_search')
  })

  it('stays within a 300-token budget while keeping header + files', () => {
    const pack = buildPack(TASK, idx, null, { budget: 300, nowSec: NOW })
    const text = renderPack(pack)
    expect(estimateTokens(text)).toBeLessThanOrEqual(300)
    expect(pack.tokensUsed).toBeLessThanOrEqual(300)
    expect(text).toContain('## Repo context for:')
    expect(text).toContain('**Likely relevant files:**')
    expect(text.split('\n').some((l) => l.startsWith('- src/billing/invoice.ts'))).toBe(true)
  })

  it('fits a tight budget by dropping whole items, keeping the header', () => {
    const pack = buildPack(TASK, idx, null, { budget: 80, nowSec: NOW })
    const text = renderPack(pack)
    expect(estimateTokens(text)).toBeLessThanOrEqual(80)
    expect(text).toContain('## Repo context for:')
  })

  it('includes one redacted excerpt anchored at the best-matching symbol', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
    fs.mkdirSync(path.join(tmp, 'src', 'billing'), { recursive: true })
    const lines: string[] = []
    for (let i = 1; i <= 60; i++) {
      if (i === 42) lines.push('export function createInvoice(c: Customer): Invoice {')
      else if (i === 45) lines.push('  const key = "SECRET"')
      else lines.push(`// line ${i}`)
    }
    fs.writeFileSync(path.join(tmp, 'src', 'billing', 'invoice.ts'), lines.join('\n'))
    const pack = buildPack(TASK, idx, null, {
      budget: 1500,
      nowSec: NOW,
      withExcerpts: true,
      root: tmp,
      redact: (s) => s.replace(/SECRET/g, '[REDACTED]'),
    })
    expect(pack.excerpts.length).toBe(1)
    expect(pack.excerpts[0]?.lines).toBe('40-51')
    expect(pack.excerpts[0]?.text).toContain('createInvoice')
    expect(pack.excerpts[0]?.text).toContain('[REDACTED]')
    expect(pack.excerpts[0]?.text).not.toContain('SECRET')
    expect(renderPack(pack)).toContain('**Excerpt src/billing/invoice.ts:40-51:**')
  })

  it('populates alreadyInspected from session state', () => {
    const state: SessionState = {
      reads: { 'src/billing/invoice.ts': 3 },
      edits: [],
      testsReminded: [],
      updatedAt: NOW,
    }
    const pack = buildPack(TASK, idx, state, { budget: 1500, nowSec: NOW })
    expect(pack.alreadyInspected).toContain('src/billing/invoice.ts')
    expect(renderPack(pack)).toContain('Already inspected: src/billing/invoice.ts')
  })

  it('is deterministic for a fixed nowSec', () => {
    const a = buildPack(TASK, idx, null, { budget: 600, nowSec: NOW })
    const b = buildPack(TASK, idx, null, { budget: 600, nowSec: NOW })
    expect(b).toEqual(a)
  })
})

describe('renderOverview', () => {
  const summary: RepoSummary = {
    updatedAt: NOW,
    sessions: [
      {
        id: 's1',
        endedAt: NOW - 3600,
        task: 'fix invoice rounding',
        filesEdited: ['src/billing/invoice.ts'],
        filesInspected: ['src/billing/invoice.ts'],
        commands: ['pnpm test (exit 0)'],
        notes: ['round half-even'],
        guardEvents: 0,
      },
    ],
  }

  it('fits the budget and contains the rules digest + sections', () => {
    const out = renderOverview(idx, summary, 400)
    expect(estimateTokens(out)).toBeLessThanOrEqual(400)
    expect(out).toContain('## Repo: fake (ts-app, 9 files)')
    expect(out).toContain('mcp__ctx__context_pack')
    expect(out).toContain('**Commands:**')
    expect(out).toContain('**Tree:**')
    expect(out).toContain('**Last session:** fix invoice rounding')
  })

  it('shrinks tree then drops commands under a tight budget', () => {
    const out = renderOverview(idx, summary, 110)
    expect(estimateTokens(out)).toBeLessThanOrEqual(110)
    expect(out).toContain('mcp__ctx__context_pack')
    expect(out).not.toContain('**Tree:**')
    expect(out).not.toContain('**Commands:**')
  })

  it('compactRecap emits only repo line + rules + last session within 150 tokens', () => {
    const out = renderOverview(idx, summary, 700, { compactRecap: true })
    expect(estimateTokens(out)).toBeLessThanOrEqual(150)
    expect(out).toContain('## Repo: fake')
    expect(out).toContain('**Last session:**')
    expect(out).not.toContain('**Tree:**')
    expect(out).not.toContain('**Commands:**')
  })
})
