import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsDir, summaryPath } from '../paths'
import { writeFileAtomic } from '../store/shards'
import type { RepoSummary, SessionEvent, SessionSummaryEntry } from '../types'
import { readSession } from './log'

const MAX_TASK_CHARS = 200
const MAX_NOTE_CHARS = 200
const MAX_NOTES = 20
const MAX_CMD_CHARS = 80
const MAX_COMMANDS = 10
const MAX_INSPECTED = 10
const MAX_SESSIONS = 5

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function loadSummary(root: string): RepoSummary {
  try {
    const raw = JSON.parse(readFileSync(summaryPath(root), 'utf8')) as Partial<RepoSummary>
    if (!raw || typeof raw !== 'object') return { updatedAt: 0, sessions: [] }
    return {
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    }
  } catch {
    return { updatedAt: 0, sessions: [] }
  }
}

function fold(id: string, events: SessionEvent[], endedAt: number): SessionSummaryEntry {
  let task: string | null = null
  const edited: string[] = []
  const readCounts = new Map<string, number>()
  const notes: string[] = []
  let guardEvents = 0

  for (const ev of events) {
    switch (ev.e) {
      case 'prompt':
        if (task === null) task = ev.text.slice(0, MAX_TASK_CHARS)
        break
      case 'edit':
        if (!edited.includes(ev.f)) edited.push(ev.f)
        break
      case 'read':
        readCounts.set(ev.f, (readCounts.get(ev.f) ?? 0) + 1)
        break
      case 'note':
        if (notes.length < MAX_NOTES) notes.push(ev.text.slice(0, MAX_NOTE_CHARS))
        break
      case 'guard':
        guardEvents++
        break
    }
  }

  const filesInspected = [...readCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_INSPECTED)
    .map(([f]) => f)

  // last 10 distinct bash commands, chronological; the latest occurrence wins its exit code
  const commands: string[] = []
  const seenCmds = new Set<string>()
  for (let i = events.length - 1; i >= 0 && commands.length < MAX_COMMANDS; i--) {
    const ev = events[i]
    if (!ev || ev.e !== 'bash') continue
    const cmd = ev.cmd.slice(0, MAX_CMD_CHARS)
    if (seenCmds.has(cmd)) continue
    seenCmds.add(cmd)
    commands.push(ev.exit !== undefined ? `${cmd} (exit ${ev.exit})` : cmd)
  }
  commands.reverse()

  return {
    id,
    endedAt,
    task: task ?? '(no prompt recorded)',
    filesEdited: edited,
    filesInspected,
    commands,
    notes,
    guardEvents,
  }
}

export function distillSession(root: string, sessionId: string, endedAtSec?: number): RepoSummary {
  const id = sanitize(sessionId)
  const dir = sessionsDir(root)
  const summary = loadSummary(root)

  // never invent a session: require some artifact (jsonl or state) to exist
  const hasArtifact =
    existsSync(join(dir, `${id}.jsonl`)) || existsSync(join(dir, `${id}.state.json`))
  if (!hasArtifact) return summary

  const endedAt = endedAtSec ?? Math.floor(Date.now() / 1000)
  const entry = fold(id, readSession(root, sessionId), endedAt)

  const sessions = [entry, ...summary.sessions.filter((s) => s.id !== id)].slice(0, MAX_SESSIONS)
  const next: RepoSummary = { updatedAt: endedAt, sessions }
  writeFileAtomic(summaryPath(root), JSON.stringify(next))
  return next
}
