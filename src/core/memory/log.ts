import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir } from '../paths'
import type { SessionEvent } from '../types'

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function appendEvent(root: string, sessionId: string, ev: SessionEvent): void {
  const dir = sessionsDir(root)
  mkdirSync(dir, { recursive: true })
  // single appendFileSync call: O_APPEND keeps small lines atomic across processes
  appendFileSync(join(dir, `${sanitize(sessionId)}.jsonl`), JSON.stringify(ev) + '\n')
}

export function readSession(root: string, sessionId: string): SessionEvent[] {
  let raw: string
  try {
    raw = readFileSync(join(sessionsDir(root), `${sanitize(sessionId)}.jsonl`), 'utf8')
  } catch {
    return []
  }
  const out: SessionEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const ev = JSON.parse(trimmed) as SessionEvent
      if (ev && typeof ev === 'object' && typeof ev.e === 'string') out.push(ev)
    } catch {
      // corrupt line (e.g. torn write): skip silently
    }
  }
  return out
}

export function latestSessionId(root: string): string | null {
  let names: string[]
  try {
    names = readdirSync(sessionsDir(root))
  } catch {
    return null
  }
  let best: string | null = null
  let bestMtime = -Infinity
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue
    let mtime: number
    try {
      mtime = statSync(join(sessionsDir(root), name)).mtimeMs
    } catch {
      continue
    }
    if (mtime > bestMtime) {
      bestMtime = mtime
      best = name.slice(0, -'.jsonl'.length)
    }
  }
  return best
}
