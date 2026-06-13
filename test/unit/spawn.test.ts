import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendPending } from '../../src/core/store/shards'
import { requestIndexRefresh, respawnIfPending } from '../../src/core/indexer/spawn'
import { gitFixture } from '../helpers'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => ({ unref: vi.fn() })) }
})

let home: string
let ROOT: string

describe('index spawn', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ctx-spawn-'))
    process.env.CLAUDE_CTX_HOME = home
    ROOT = gitFixture('ts-app')
    vi.mocked(spawn).mockClear()
  })

  afterEach(() => {
    delete process.env.CLAUDE_CTX_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('requestIndexRefresh spawns incremental ctx index', () => {
    requestIndexRefresh(ROOT, '/bin/cli.cjs')
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/bin/cli.cjs', 'index', '--repo', ROOT],
      { detached: true, stdio: 'ignore' },
    )
  })

  it('respawnIfPending spawns only when pending is non-empty', () => {
    respawnIfPending(ROOT, '/bin/cli.cjs')
    expect(spawn).not.toHaveBeenCalled()

    appendPending(ROOT, ['src/foo.ts'])
    respawnIfPending(ROOT, '/bin/cli.cjs')
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
