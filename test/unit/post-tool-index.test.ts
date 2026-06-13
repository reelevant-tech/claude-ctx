import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitFixture } from '../helpers'

const requestIndexRefresh = vi.fn()

vi.mock('../../src/core/indexer/spawn', () => ({
  requestIndexRefresh: (...args: unknown[]) => requestIndexRefresh(...args),
  cliJsPath: () => '/bin/cli.cjs',
}))

let home: string
let ROOT: string

describe('post-tool index refresh', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ctx-post-edit-'))
    process.env.CLAUDE_CTX_HOME = home
    ROOT = gitFixture('ts-app')
    requestIndexRefresh.mockClear()
  })

  afterEach(() => {
    delete process.env.CLAUDE_CTX_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('triggers an incremental index rebuild after an edit', async () => {
    const { handle } = await import('../../src/hooks/post-tool')
    await handle({
      session_id: 'e1',
      cwd: ROOT,
      tool_name: 'Edit',
      tool_input: { file_path: join(ROOT, 'src/index.ts') },
    })
    expect(requestIndexRefresh).toHaveBeenCalledWith(ROOT, '/bin/cli.cjs')
  })
})
