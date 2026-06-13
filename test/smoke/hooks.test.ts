import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'
import { summaryPath } from '../../src/core/paths'
import { gitFixture } from '../helpers'

let home: string
let ROOT: string
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ctx-hooks-'))
  process.env.CLAUDE_CTX_HOME = home
  ROOT = gitFixture('ts-app')
  await buildIndex(ROOT, { mode: 'full' })
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
    expect(ctx.toLowerCase()).toContain('start from these')
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
    await buildIndex(ROOT, { mode: 'full' })
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

describe('pre-bash search interception', () => {
  it('injects ranked matches for a bash grep without blocking', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 'bs1',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn createInvoice .' },
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('Ranked indexed matches')
    expect(ctx).toContain('billing/invoice.ts')
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('injects ranked matches for a bash find -name', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 'bs2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'find . -name "*invoice*"' },
    })
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('billing/invoice.ts')
  })

  it('prefers the embedded grep pattern over the find -name glob', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 'bs3',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'find . -name "*.ts" -exec grep -l "createInvoice" {} \\;' },
    })
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('billing/invoice.ts')
  })

  it('nudges toward tree tools on a bare file enumeration', async () => {
    const h = await importHandlers()
    const out = await h.preBash({
      session_id: 'bs4',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'find . -type f -name "*.ts"' },
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('mcp__ctx__repo_tree')
    expect(ctx).not.toContain('Ranked indexed matches')
  })
})

describe('pre-grep', () => {
  it('injects ranked indexed matches for a Grep pattern', async () => {
    const h = await importHandlers()
    const out = await h.preGrep({ session_id: 'g1', cwd: ROOT, tool_name: 'Grep', tool_input: { pattern: 'createInvoice' } })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('Ranked indexed matches')
    expect(ctx).toContain('billing/invoice.ts')
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined() // never blocks
  })

  it('falls back to a nudge when the pattern is too thin to rank', async () => {
    const h = await importHandlers()
    const out = await h.preGrep({ session_id: 'g2', cwd: ROOT, tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('mcp__ctx__symbol_search')
    expect(ctx).not.toContain('Ranked indexed matches')
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

describe('post-tool auto-expand + index observation', () => {
  it('injects the related neighbourhood after reading an indexed file, once per file', async () => {
    const h = await importHandlers()
    const target = join(ROOT, 'src/index.ts') // imports billing/invoice.ts in the fixture
    const first = await h.postTool({ session_id: 'ar', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: target } })
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain('Related to src/index.ts')
    // second read of the same file does not re-inject
    const second = await h.postTool({ session_id: 'ar', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: target } })
    expect(second.hookSpecificOutput).toBeUndefined()
  })

  it('an mcp__ctx__ call resets the read-cascade streak', async () => {
    const { loadState } = await import('../../src/core/memory/state')
    const h = await importHandlers()
    for (const f of ['src/index.ts', 'src/util/format.ts', 'src/billing/customer.ts']) {
      await h.postTool({ session_id: 'rs', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: join(ROOT, f) } })
    }
    expect(loadState(ROOT, 'rs').readStreak).toBe(3)
    await h.postTool({ session_id: 'rs', cwd: ROOT, tool_name: 'mcp__ctx__context_pack', tool_input: { task: 'x' } })
    expect(loadState(ROOT, 'rs').readStreak).toBe(0)
  })
})

describe('pre-read cascade nudge', () => {
  it('nudges toward context_pack after the cascade limit, referencing the task', async () => {
    const h = await importHandlers()
    await h.userPrompt({ session_id: 'cn', cwd: ROOT, prompt: 'wire up invoice rounding' })
    for (const f of ['src/index.ts', 'src/util/format.ts', 'src/billing/customer.ts']) {
      await h.postTool({ session_id: 'cn', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: join(ROOT, f) } })
    }
    const out = await h.preRead({ session_id: 'cn', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: join(ROOT, 'src/billing/invoice.ts') } })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('mcp__ctx__context_pack')
    expect(ctx).toContain('invoice rounding') // the task
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined() // guidance mode never blocks
  })

  it('does not nudge before the cascade limit', async () => {
    const h = await importHandlers()
    await h.userPrompt({ session_id: 'cn2', cwd: ROOT, prompt: 'work' })
    await h.postTool({ session_id: 'cn2', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: join(ROOT, 'src/index.ts') } })
    const out = await h.preRead({ session_id: 'cn2', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: join(ROOT, 'src/util/format.ts') } })
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('context_pack')
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
