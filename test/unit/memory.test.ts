import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { distillSession } from '../../src/core/memory/distill'
import { appendEvent, latestSessionId, readSession } from '../../src/core/memory/log'
import {
  bumpRead,
  loadState,
  markTestsReminded,
  recordEdit,
  saveState,
  setFirstPrompt,
} from '../../src/core/memory/state'
import { sessionsDir, summaryPath } from '../../src/core/paths'
import type { SessionEvent, SessionState } from '../../src/core/types'

let tmp: string
let root: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
  process.env.CLAUDE_CTX_HOME = path.join(tmp, 'home')
  root = path.join(tmp, 'repo')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(tmp, { recursive: true, force: true })
})

const ev = (e: SessionEvent): SessionEvent => e

describe('memory/log', () => {
  it('appends and reads back events, skipping corrupt lines', () => {
    const events: SessionEvent[] = [
      { ts: 1, e: 'prompt', text: 'fix the bug' },
      { ts: 2, e: 'read', f: 'src/a.ts' },
      { ts: 3, e: 'edit', f: 'src/a.ts', tool: 'Edit' },
    ]
    for (const e of events) appendEvent(root, 's1', e)
    appendFileSync(path.join(sessionsDir(root), 's1.jsonl'), '{not json\n')
    appendEvent(root, 's1', { ts: 4, e: 'bash', cmd: 'npm test', exit: 0 })

    const got = readSession(root, 's1')
    expect(got).toHaveLength(4)
    expect(got[0]).toEqual(events[0])
    expect(got[3]).toEqual({ ts: 4, e: 'bash', cmd: 'npm test', exit: 0 })
  })

  it('sanitizes session ids to [a-zA-Z0-9_-]', () => {
    appendEvent(root, 'a/b c!', ev({ ts: 1, e: 'read', f: 'x.ts' }))
    expect(existsSync(path.join(sessionsDir(root), 'a_b_c_.jsonl'))).toBe(true)
    expect(readSession(root, 'a/b c!')).toHaveLength(1)
  })

  it('readSession returns [] for missing file', () => {
    expect(readSession(root, 'nope')).toEqual([])
  })

  it('latestSessionId picks newest jsonl by mtime, null when none', () => {
    expect(latestSessionId(root)).toBeNull()
    appendEvent(root, 'old', ev({ ts: 1, e: 'read', f: 'a.ts' }))
    appendEvent(root, 'new', ev({ ts: 2, e: 'read', f: 'b.ts' }))
    utimesSync(path.join(sessionsDir(root), 'old.jsonl'), 1000, 1000)
    utimesSync(path.join(sessionsDir(root), 'new.jsonl'), 2000, 2000)
    expect(latestSessionId(root)).toBe('new')
  })
})

describe('memory/state', () => {
  it('loadState returns fresh empty state when missing or corrupt', () => {
    expect(loadState(root, 'none')).toEqual({ reads: {}, edits: [], testsReminded: [], updatedAt: 0 })
    mkdirSync(sessionsDir(root), { recursive: true })
    appendFileSync(path.join(sessionsDir(root), 'bad.state.json'), '{{{')
    expect(loadState(root, 'bad')).toEqual({ reads: {}, edits: [], testsReminded: [], updatedAt: 0 })
  })

  it('bumpRead increments counts and persists', () => {
    bumpRead(root, 's1', 'src/a.ts')
    const st = bumpRead(root, 's1', 'src/a.ts')
    expect(st.reads['src/a.ts']).toBe(2)
    expect(loadState(root, 's1').reads['src/a.ts']).toBe(2)
    expect(st.updatedAt).toBeGreaterThan(0)
  })

  it('bumpRead caps reads at 500, evicting lowest count then oldest key', () => {
    const reads: Record<string, number> = {}
    reads['low-old.ts'] = 1
    for (let i = 0; i < 498; i++) reads[`f${i}.ts`] = 2
    reads['low-new.ts'] = 1
    const seed: SessionState = { reads, edits: [], testsReminded: [], updatedAt: 0 }
    saveState(root, 's1', seed)

    const st = bumpRead(root, 's1', 'fresh.ts')
    expect(Object.keys(st.reads)).toHaveLength(500)
    expect(st.reads['low-old.ts']).toBeUndefined()
    expect(st.reads['low-new.ts']).toBe(1)
    expect(st.reads['fresh.ts']).toBe(1)
  })

  it('recordEdit and markTestsReminded dedupe', () => {
    recordEdit(root, 's1', 'src/a.ts')
    recordEdit(root, 's1', 'src/b.ts')
    const st = recordEdit(root, 's1', 'src/a.ts')
    expect(st.edits).toEqual(['src/a.ts', 'src/b.ts'])
    markTestsReminded(root, 's1', 'src/a.ts')
    expect(markTestsReminded(root, 's1', 'src/a.ts').testsReminded).toEqual(['src/a.ts'])
  })

  it('setFirstPrompt only sets when absent and truncates to 200 chars', () => {
    const long = 'x'.repeat(300)
    const st1 = setFirstPrompt(root, 's1', long)
    expect(st1.firstPrompt).toHaveLength(200)
    const st2 = setFirstPrompt(root, 's1', 'second prompt')
    expect(st2.firstPrompt).toBe('x'.repeat(200))
    expect(loadState(root, 's1').firstPrompt).toBe('x'.repeat(200))
  })
})

function logBasicSession(id: string, prompt: string) {
  appendEvent(root, id, { ts: 1, e: 'prompt', text: prompt })
  appendEvent(root, id, { ts: 2, e: 'edit', f: `src/${id}.ts`, tool: 'Edit' })
}

describe('memory/distill', () => {
  it('distills a session end-to-end and orders newest first', () => {
    appendEvent(root, 'A', { ts: 1, e: 'prompt', text: 'p'.repeat(250) })
    appendEvent(root, 'A', { ts: 2, e: 'prompt', text: 'second prompt ignored' })
    appendEvent(root, 'A', { ts: 3, e: 'edit', f: 'src/a.ts', tool: 'Edit' })
    appendEvent(root, 'A', { ts: 4, e: 'edit', f: 'src/b.ts', tool: 'Write' })
    appendEvent(root, 'A', { ts: 5, e: 'edit', f: 'src/a.ts', tool: 'Edit' })
    appendEvent(root, 'A', { ts: 6, e: 'read', f: 'src/z.ts' })
    appendEvent(root, 'A', { ts: 7, e: 'read', f: 'src/y.ts' })
    appendEvent(root, 'A', { ts: 8, e: 'read', f: 'src/y.ts' })
    appendEvent(root, 'A', { ts: 9, e: 'read', f: 'src/x.ts' })
    appendEvent(root, 'A', { ts: 10, e: 'bash', cmd: 'npm test', exit: 1 })
    appendEvent(root, 'A', { ts: 11, e: 'bash', cmd: 'c'.repeat(100) })
    appendEvent(root, 'A', { ts: 12, e: 'bash', cmd: 'npm test', exit: 0 })
    appendEvent(root, 'A', { ts: 13, e: 'note', text: 'n'.repeat(250), kind: 'decision' })
    appendEvent(root, 'A', { ts: 14, e: 'guard', kind: 'deny', target: '.env' })
    appendEvent(root, 'A', { ts: 15, e: 'guard', kind: 'warn', target: 'rm -rf' })

    const s1 = distillSession(root, 'A', 1000)
    expect(s1.sessions).toHaveLength(1)
    const a = s1.sessions[0]!
    expect(a.id).toBe('A')
    expect(a.endedAt).toBe(1000)
    expect(a.task).toBe('p'.repeat(200))
    expect(a.filesEdited).toEqual(['src/a.ts', 'src/b.ts'])
    expect(a.filesInspected).toEqual(['src/y.ts', 'src/x.ts', 'src/z.ts'])
    expect(a.commands).toEqual(['c'.repeat(80), 'npm test (exit 0)'])
    expect(a.notes).toEqual(['n'.repeat(200)])
    expect(a.guardEvents).toBe(2)
    expect(s1.updatedAt).toBe(1000)

    logBasicSession('B', 'task B')
    const s2 = distillSession(root, 'B', 2000)
    expect(s2.sessions.map((s) => s.id)).toEqual(['B', 'A'])
  })

  it('re-distilling the same session replaces its entry (idempotent)', () => {
    logBasicSession('A', 'task A')
    logBasicSession('B', 'task B')
    distillSession(root, 'A', 1000)
    distillSession(root, 'B', 2000)
    distillSession(root, 'B', 2000)
    const bytes1 = readFileSync(summaryPath(root), 'utf8')
    const again = distillSession(root, 'B', 2000)
    expect(again.sessions).toHaveLength(2)
    expect(readFileSync(summaryPath(root), 'utf8')).toBe(bytes1)
  })

  it('caps summary at 5 sessions, newest first', () => {
    for (let i = 1; i <= 6; i++) {
      logBasicSession(`s${i}`, `task ${i}`)
      distillSession(root, `s${i}`, 1000 + i)
    }
    const sum = distillSession(root, 's6', 1006)
    expect(sum.sessions).toHaveLength(5)
    expect(sum.sessions.map((s) => s.id)).toEqual(['s6', 's5', 's4', 's3', 's2'])
  })

  it('session with only a state.json gets a "(no prompt recorded)" entry', () => {
    saveState(root, 'ghost', { reads: {}, edits: [], testsReminded: [], updatedAt: 5 })
    const sum = distillSession(root, 'ghost', 1234)
    expect(sum.sessions).toHaveLength(1)
    expect(sum.sessions[0]!.task).toBe('(no prompt recorded)')
    expect(sum.sessions[0]!.guardEvents).toBe(0)
  })

  it('unknown session leaves the summary untouched', () => {
    logBasicSession('A', 'task A')
    distillSession(root, 'A', 1000)
    const before = readFileSync(summaryPath(root), 'utf8')
    const sum = distillSession(root, 'never-existed', 9999)
    expect(sum.sessions.map((s) => s.id)).toEqual(['A'])
    expect(sum.updatedAt).toBe(1000)
    expect(readFileSync(summaryPath(root), 'utf8')).toBe(before)
  })
})
