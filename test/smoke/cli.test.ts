import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitFixture } from '../helpers'

let home: string
let ROOT: string
let outBuf: string[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-cli-'))
  process.env.CLAUDE_CTX_HOME = home
  ROOT = gitFixture('ts-app')
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

const text = () => outBuf.join('')

describe('cli commands', () => {
  it('index then overview/tree/pack/symbols/tests/risky/commands', async () => {
    const idx = (await import('../../src/cli/commands/index-cmd')).run
    expect(await idx(['--repo', ROOT, '--full'])).toBe(0)
    expect(text()).toContain('indexed')
    outBuf.length = 0

    const overview = (await import('../../src/cli/commands/overview')).run
    expect(await overview(['--repo', ROOT])).toBe(0)
    expect(text()).toContain('ts-app')
    outBuf.length = 0

    const tree = (await import('../../src/cli/commands/tree')).run
    expect(await tree(['--repo', ROOT])).toBe(0)
    expect(text().length).toBeGreaterThan(0)
    outBuf.length = 0

    const pack = (await import('../../src/cli/commands/pack')).run
    expect(await pack(['--repo', ROOT, 'fix', 'invoice', 'rounding'])).toBe(0)
    expect(text()).toContain('invoice')
    outBuf.length = 0

    const symbols = (await import('../../src/cli/commands/symbols')).run
    expect(await symbols(['--repo', ROOT, 'createInvoice'])).toBe(0)
    expect(text()).toContain('createInvoice')
    outBuf.length = 0

    const tests = (await import('../../src/cli/commands/tests-cmd')).run
    expect(await tests(['--repo', ROOT, 'src/billing/invoice.ts'])).toBe(0)
    expect(text()).toContain('invoice.test.ts')
    outBuf.length = 0

    const risky = (await import('../../src/cli/commands/risky')).run
    expect(await risky(['--repo', ROOT, '.env'])).toBe(0)
    expect(text()).toContain('secret')
    outBuf.length = 0

    const commands = (await import('../../src/cli/commands/commands-cmd')).run
    expect(await commands(['--repo', ROOT])).toBe(0)
    expect(text()).toContain('test')
  })
})
