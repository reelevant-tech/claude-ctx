import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { loadIndex } from '../../src/core/store/shards'
import { traceSymbol, renderTraceSymbol } from '../../src/core/trace/symbol'
import { toolImpls } from '../../src/mcp/tools'

const ROOT = join(__dirname, '..', '..', 'fixtures', 'ts-app')

let home: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctx-trace-'))
  process.env.CLAUDE_CTX_HOME = home
  await buildIndex(ROOT, { mode: 'full' })
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('traceSymbol', () => {
  it('returns definition, TS references, callees, and import path', () => {
    const idx = loadIndex(ROOT)!
    const trace = traceSymbol(ROOT, idx, 'createInvoice')!
    expect(trace.definition?.file).toBe('src/billing/invoice.ts')
    expect(trace.references.source).toBe('typescript')
    expect(trace.references.refs.some((r) => r.file === 'src/index.ts')).toBe(true)
    expect(trace.callees.some((c) => c.callee === 'parse')).toBe(true)
    expect(trace.related.importedBy).toContain('src/index.ts')
    expect(trace.importPaths.some((p) => p[0] === 'src/index.ts' && p[p.length - 1] === 'src/billing/invoice.ts')).toBe(
      true,
    )
  })

  it('renders a structured report with snippets', () => {
    const idx = loadIndex(ROOT)!
    const trace = traceSymbol(ROOT, idx, 'createInvoice')!
    const txt = renderTraceSymbol(ROOT, trace)
    expect(txt).toContain('## trace: createInvoice')
    expect(txt).toContain('**Definition:**')
    expect(txt).toContain('**References** (typescript')
    expect(txt).toContain('createInvoice')
  })
})

describe('mcp trace_symbol', () => {
  it('is registered and returns trace output', () => {
    expect(Object.keys(toolImpls)).toContain('trace_symbol')
    const txt = toolImpls.trace_symbol!(ROOT, { symbol: 'createInvoice' })
    expect(txt).toContain('trace: createInvoice')
    expect(txt).toContain('src/index.ts')
  })

  it('references uses TypeScript when available', () => {
    const txt = toolImpls.references!(ROOT, { symbol: 'createInvoice' })
    expect(txt).toContain('TypeScript')
    expect(txt).toContain('src/index.ts')
  })
})
