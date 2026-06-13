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
    expect(txt).toContain('**References** — typed')
    expect(txt).toContain('(roles: def/call/use)')
    expect(txt).toContain('[call]') // the createInvoice() call site in src/index.ts
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

  it('references uses TypeScript when available, with file-breadth coverage', () => {
    const txt = toolImpls.references!(ROOT, { symbol: 'createInvoice' })
    expect(txt).toContain('typed, complete within indexed TS files')
    expect(txt).toMatch(/\d+ refs? across \d+ files?/)
    expect(txt).toContain('src/index.ts')
  })

  it('symbol_search reports total match count + file breadth', () => {
    const txt = toolImpls.symbol_search!(ROOT, { query: 'createInvoice' })
    expect(txt).toMatch(/\d+ symbols? match "createInvoice" across \d+ files?:/)
    expect(txt).toContain('createInvoice')
  })

  it('trace_symbol kind:"calls" filters to call-sites only', () => {
    const txt = toolImpls.trace_symbol!(ROOT, { symbol: 'createInvoice', kind: 'calls' })
    expect(txt).toContain('**Call-sites**')
    expect(txt).not.toContain('(roles: def/call/use)')
  })

  it('symbol_body returns the full source body of a symbol', () => {
    expect(Object.keys(toolImpls)).toContain('symbol_body')
    const txt = toolImpls.symbol_body!(ROOT, { symbol: 'createInvoice' })
    expect(txt).toContain('createInvoice — src/billing/invoice.ts:')
    expect(txt).toContain('```')
    expect(txt).toContain('function createInvoice')
  })

  it('call_chain builds a best-effort execution flow', () => {
    expect(Object.keys(toolImpls)).toContain('call_chain')
    const txt = toolImpls.call_chain!(ROOT, { symbol: 'createInvoice' })
    expect(txt).toContain('call_chain: createInvoice')
    expect(txt).toContain('→ parse()')
  })

  it('field_refs returns read/write sites of a member field', () => {
    expect(Object.keys(toolImpls)).toContain('field_refs')
    // Customer.name is read in src/billing/invoice.ts (`${c.name}`)
    const txt = toolImpls.field_refs!(ROOT, { field: 'name' })
    expect(txt).toContain('field: name')
    expect(txt).toContain('billing/invoice.ts')
    expect(txt).toContain('**Reads**')
  })
})
