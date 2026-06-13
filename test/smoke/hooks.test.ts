import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { summaryPath } from '../../src/core/paths'
import { gitFixture } from '../helpers'

let home: string
let ROOT: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-hooks-'))
  process.env.CLAUDE_CTX_HOME = home
  ROOT = gitFixture('ts-app')
  buildIndex(ROOT, { mode: 'full' })
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
})

async function importHandlers() {
  return {
    sessionStart: (await import('../../src/hooks/session-start')).handle,
    userPrompt: (await import('../../src/hooks/user-prompt-submit')).handle,
    preBash: (await import('../../src/hooks/pre-bash')).handle,
    preRead: (await import('../../src/hooks/pre-read')).handle,
    preGrep: (await import('../../src/hooks/pre-grep')).handle,
    postTool: (await import('../../src/hooks/post-tool')).handle,
    stop: (await import('../../src/hooks/stop')).handle,
  }
}

describe('session-start', () => {
  it('injects an overview with project type and rules digest', async () => {
    const h = await importHandlers()
    const out = await h.sessionStart({ session_id: 's1', cwd: ROOT, source: 'startup' })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('ts-app')
    expect(ctx).toContain('Rules')
    expect(ctx.toLowerCase()).toContain('mcp__ctx__context_pack')
  })
})

describe('user-prompt-submit', () => {
  it('injects a context pack for a coding prompt', async () => {
    const h = await importHandlers()
    const out = await h.userPrompt({
      session_id: 's2',
      cwd: ROOT,
      prompt: 'fix invoice rounding in createInvoice',
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('auto-context')
    expect(ctx).toContain('billing/invoice.ts')
  })

  it('skips conversational prompts', async () => {
    const h = await importHandlers()
    const out = await h.userPrompt({ session_id: 's3', cwd: ROOT, prompt: 'thanks!' })
    expect(out.hookSpecificOutput).toBeUndefined()
  })
})

describe('pre-bash (warn mode default)', () => {
  it('warns on cat .env without setting a permissionDecision', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 's4',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'cat .env' },
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('WARNING (severe)')
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('is silent on clean commands', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 's5',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    })
    expect(out.hookSpecificOutput).toBeUndefined()
  })
})

describe('pre-bash (enforce mode via repo config)', () => {
  it('denies a severe command when guard.bash=enforce', async () => {
    mkdirSync(join(ROOT, '.claude-context'), { recursive: true })
    writeFileSync(
      join(ROOT, '.claude-context', 'config.json'),
      JSON.stringify({ guard: { bash: 'enforce' } }),
    )
    buildIndex(ROOT, { mode: 'full' })
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 'e1',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    })
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  })
})

describe('pre-grep', () => {
  it('nudges on an unscoped repo-wide search', async () => {
    const h = await importHandlers()
    const out = await h.preGrep({ cwd: ROOT, tool_name: 'Grep', tool_input: { pattern: 'createInvoice' } })
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('mcp__ctx__symbol_search')
  })
})

describe('post-tool + pre-read repeat detection', () => {
  it('warns on the 3rd read of the same file', async () => {
    const h = await importHandlers()
    const target = join(ROOT, 'src/billing/invoice.ts')
    for (let i = 0; i < 2; i++) {
      await h.postTool({ session_id: 'r1', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: target } })
    }
    const out = await h.preRead({
      session_id: 'r1',
      cwd: ROOT,
      tool_name: 'Read',
      tool_input: { file_path: target },
    })
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('already read')
  })
})

describe('stop', () => {
  it('distills a session into summary.json', async () => {
    const h = await importHandlers()
    await h.userPrompt({ session_id: 'sum1', cwd: ROOT, prompt: 'work on invoices' })
    await h.postTool({
      session_id: 'sum1',
      cwd: ROOT,
      tool_name: 'Edit',
      tool_input: { file_path: join(ROOT, 'src/billing/invoice.ts') },
    })
    await h.stop({ session_id: 'sum1', cwd: ROOT })
    const summary = JSON.parse(readFileSync(summaryPath(ROOT), 'utf8'))
    expect(summary.sessions.length).toBeGreaterThanOrEqual(1)
  })
})
