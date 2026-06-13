import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIndex } from '../../src/core/indexer/index'

const ROOT = join(__dirname, '..', '..', 'fixtures', 'ts-app')

let home: string

describe('post-tool discovery nudge', () => {
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ctx-post-disc-'))
    process.env.CLAUDE_CTX_HOME = home
    await buildIndex(ROOT, { mode: 'full' })
  })

  afterEach(() => {
    delete process.env.CLAUDE_CTX_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('nudges after a broad find instead of leaving the agent blind', async () => {
    const { handle } = await import('../../src/hooks/post-tool')
    const out = await handle({
      session_id: 'd1',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'find . -name "*.ts"' },
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('[claude-ctx] Shell discovery')
    expect(ctx).toContain('find-broad')
    expect(ctx).toContain('trace_symbol')
  })

  it('nudges after trace_symbol via bash', async () => {
    const { handle } = await import('../../src/hooks/post-tool')
    const out = await handle({
      session_id: 'd2',
      cwd: ROOT,
      tool_name: 'Bash',
      tool_input: { command: 'trace_symbol createInvoice' },
    })
    const ctx = out.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('ctx-cli-via-shell')
    expect(ctx).toContain('mcp__ctx__trace_symbol')
  })
})
