import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { createServer, toolImpls } from '../../src/mcp/tools'

const FIX = join(__dirname, '..', '..', 'fixtures')
const ROOT = join(FIX, 'ts-app')

let home: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctx-mcp-'))
  process.env.CLAUDE_CTX_HOME = home
  await buildIndex(ROOT, { mode: 'full' })
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('toolImpls', () => {
  it('registers exactly 15 tools', async () => {
    expect(Object.keys(toolImpls).length).toBe(15)
  })

  it('repo_overview reports the project', async () => {
    expect(toolImpls.repo_overview!(ROOT, {})).toContain('ts-app')
  })

  it('context_pack surfaces the invoice file', async () => {
    const txt = await toolImpls.context_pack!(ROOT, { task: 'fix invoice rounding' })
    expect(txt).toContain('billing/invoice.ts')
  })

  it('symbol_search finds an exported symbol', async () => {
    expect(toolImpls.symbol_search!(ROOT, { query: 'createInvoice' })).toContain('createInvoice')
  })

  it('find_tests maps the invoice test', async () => {
    expect(toolImpls.find_tests!(ROOT, { path: 'src/billing/invoice.ts' })).toContain('invoice.test.ts')
  })

  it('risk_check flags the .env file as secret', async () => {
    expect(toolImpls.risk_check!(ROOT, { path: '.env' })).toContain('secret')
  })

  it('related_files groups imports and importers', async () => {
    const txt = toolImpls.related_files!(ROOT, { path: 'src/billing/invoice.ts' })
    expect(txt).toContain('Related to src/billing/invoice.ts')
  })

  it('dep_trace finds a path', async () => {
    const txt = toolImpls.dep_trace!(ROOT, { from: 'src/index.ts', to: 'src/billing/invoice.ts' })
    expect(txt).toContain('→')
  })

  it('session_note acknowledges', async () => {
    expect(toolImpls.session_note!(ROOT, { text: 'decided to refactor billing' })).toBe('noted')
  })

  it('returns guidance instead of throwing when there is no index', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ctx-empty-'))
    try {
      expect(toolImpls.repo_overview!(empty, {})).toContain('No index')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('createServer', () => {
  it('constructs without throwing', async () => {
    expect(() => createServer({ root: ROOT })).not.toThrow()
  })
})
