import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../paths'
import { writeFileAtomic } from '../store/shards'
import type { SessionState } from '../types'

const MAX_READ_ENTRIES = 500
const MAX_PROMPT_CHARS = 200

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function statePath(root: string, sessionId: string): string {
  return join(sessionsDir(root), `${sanitize(sessionId)}.state.json`)
}

function emptyState(): SessionState {
  return { reads: {}, edits: [], testsReminded: [], updatedAt: 0 }
}

export function loadState(root: string, sessionId: string): SessionState {
  try {
    const raw = JSON.parse(readFileSync(statePath(root, sessionId), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
    const r = raw as Partial<SessionState>
    const st: SessionState = {
      reads: r.reads && typeof r.reads === 'object' && !Array.isArray(r.reads) ? r.reads : {},
      edits: Array.isArray(r.edits) ? r.edits : [],
      testsReminded: Array.isArray(r.testsReminded) ? r.testsReminded : [],
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    }
    if (typeof r.firstPrompt === 'string') st.firstPrompt = r.firstPrompt
    return st
  } catch {
    return emptyState()
  }
}

export function saveState(root: string, sessionId: string, st: SessionState): void {
  writeFileAtomic(statePath(root, sessionId), JSON.stringify(st))
}

function touchAndSave(root: string, sessionId: string, st: SessionState): SessionState {
  st.updatedAt = Math.floor(Date.now() / 1000)
  saveState(root, sessionId, st)
  return st
}

/** Evict lowest read count first; ties resolved by key insertion order (oldest first). */
function capReads(reads: Record<string, number>): void {
  for (;;) {
    const keys = Object.keys(reads)
    if (keys.length <= MAX_READ_ENTRIES) return
    let victim: string | undefined
    let min = Infinity
    for (const k of keys) {
      const c = reads[k] ?? 0
      if (c < min) {
        min = c
        victim = k
      }
    }
    if (victim === undefined) return
    delete reads[victim]
  }
}

export function bumpRead(root: string, sessionId: string, rel: string): SessionState {
  const st = loadState(root, sessionId)
  st.reads[rel] = (st.reads[rel] ?? 0) + 1
  capReads(st.reads)
  return touchAndSave(root, sessionId, st)
}

export function recordEdit(root: string, sessionId: string, rel: string): SessionState {
  const st = loadState(root, sessionId)
  if (!st.edits.includes(rel)) st.edits.push(rel)
  return touchAndSave(root, sessionId, st)
}

export function markTestsReminded(root: string, sessionId: string, rel: string): SessionState {
  const st = loadState(root, sessionId)
  if (!st.testsReminded.includes(rel)) st.testsReminded.push(rel)
  return touchAndSave(root, sessionId, st)
}

export function setFirstPrompt(root: string, sessionId: string, prompt: string): SessionState {
  const st = loadState(root, sessionId)
  if (st.firstPrompt !== undefined) return st
  st.firstPrompt = prompt.slice(0, MAX_PROMPT_CHARS)
  return touchAndSave(root, sessionId, st)
}
