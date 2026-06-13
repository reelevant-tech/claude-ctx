import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { run as evalRun } from '../../src/cli/commands/eval'
import { gitFixture } from '../helpers'

let home: string
let ROOT: string
let outBuf: string[]
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctx-eval-'))
  process.env.CLAUDE_CTX_HOME = home
  ROOT = gitFixture('ts-app')
  await buildIndex(ROOT, { mode: 'full' })
  outBuf = []
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    outBuf.push(String(s))
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.CLAUDE_CTX_HOME
  process.exitCode = undefined
  rmSync(home, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
})

describe('ctx eval', () => {
  it('runs queries and reports per-mode hit@k (lexical fallback, no embedder)', async () => {
    const qfile = join(home, 'q.json')
    writeFileSync(
      qfile,
      JSON.stringify([{ query: 'fix invoice rounding in createInvoice', repo: ROOT, expect: ['billing/invoice'] }]),
    )
    const code = await evalRun([qfile, '--k', '8'])
    expect(code).toBe(0)
    const text = outBuf.join('')
    expect(text).toContain('lexical')
    expect(text).toContain('hybrid')
    expect(text).toContain('hit@8')
    // lexical alone should already find the invoice file
    expect(text).toMatch(/lexical: 1\/1/)
  })
})
