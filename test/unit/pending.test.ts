import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendPending,
  clearPending,
  clearPendingSubset,
  loadPending,
} from '../../src/core/store/shards'
import { gitFixture } from '../helpers'

let home: string
let ROOT: string

describe('pending queue (append-only)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ctx-pending-'))
    process.env.CLAUDE_CTX_HOME = home
    ROOT = gitFixture('ts-app')
  })

  afterEach(() => {
    delete process.env.CLAUDE_CTX_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('accumulates separate appends without clobbering (C2)', () => {
    // Each call is an independent O_APPEND write — mirrors two PostToolUse hooks.
    appendPending(ROOT, ['a.ts'])
    appendPending(ROOT, ['b.ts'])
    appendPending(ROOT, ['a.ts']) // duplicate
    expect(new Set(loadPending(ROOT).dirty)).toEqual(new Set(['a.ts', 'b.ts']))
  })

  it('clearPending drops the whole queue', () => {
    appendPending(ROOT, ['a.ts', 'b.ts'])
    clearPending(ROOT)
    expect(loadPending(ROOT).dirty).toEqual([])
  })

  it('clearPendingSubset removes only processed files, keeping mid-build edits (C1)', () => {
    appendPending(ROOT, ['a.ts', 'b.ts']) // pending at build start
    const processed = loadPending(ROOT).dirty
    appendPending(ROOT, ['c.ts']) // edit lands during the build
    clearPendingSubset(ROOT, processed)
    // a.ts/b.ts were processed and cleared; c.ts survives → respawn will catch it
    expect(loadPending(ROOT).dirty).toEqual(['c.ts'])
  })

  it('clearPendingSubset truncates when nothing survives', () => {
    appendPending(ROOT, ['a.ts'])
    clearPendingSubset(ROOT, ['a.ts'])
    expect(loadPending(ROOT).dirty).toEqual([])
  })

  it('loadPending is empty when no queue exists', () => {
    expect(loadPending(ROOT).dirty).toEqual([])
  })
})
