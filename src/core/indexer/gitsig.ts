import { execFileSync } from 'node:child_process'
import type { CtxConfig, FileGitInfo, GitShard, RecentChange } from '../types'

export interface GitSignals {
  shard: GitShard
  perFile: Map<string, FileGitInfo>
}

const EMPTY: () => GitSignals = () => ({
  shard: { recent: [], churn: {}, cochange: {} },
  perFile: new Map(),
})

// "<40-hex>\t<epoch>\t<subject>" — subject may itself contain tabs
const HEADER = /^([0-9a-f]{40})\t(\d+)\t(.*)$/

interface Commit {
  ts: number
  subject: string
  files: string[]
}

/**
 * One `git log --name-only` pass over the last cfg.cochangeCommits commits.
 * Fails open: any git error yields empty signals.
 */
export function collectGitSignals(
  root: string,
  cfg: CtxConfig,
  knownFiles: Set<string>,
): GitSignals {
  let out: string
  try {
    out = execFileSync(
      'git',
      ['log', '--name-only', '--pretty=format:%H%x09%ct%x09%s', '-n', String(cfg.cochangeCommits)],
      {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
  } catch {
    return EMPTY()
  }

  // newest first, matching git log order
  const commits: Commit[] = []
  let cur: Commit | null = null
  for (const line of out.split('\n')) {
    if (line === '') continue
    const m = HEADER.exec(line)
    if (m) {
      cur = { ts: Number(m[2]), subject: m[3] ?? '', files: [] }
      commits.push(cur)
    } else if (cur && knownFiles.has(line)) {
      cur.files.push(line)
    }
  }

  const recent: RecentChange[] = []
  const seen = new Set<string>()
  const churnMap = new Map<string, number>()
  const lastTs = new Map<string, number>()
  const pairs = new Map<string, Map<string, number>>()

  for (const c of commits) {
    const distinct = [...new Set(c.files)]
    for (const f of distinct) {
      churnMap.set(f, (churnMap.get(f) ?? 0) + 1)
      if (!lastTs.has(f)) lastTs.set(f, c.ts) // newest-first => first hit wins
      if (!seen.has(f) && recent.length < 50) {
        seen.add(f)
        recent.push({ f, ts: c.ts, subject: c.subject.slice(0, 80) })
      }
    }
    if (distinct.length >= 2 && distinct.length <= 30) {
      for (let i = 0; i < distinct.length; i++) {
        for (let j = i + 1; j < distinct.length; j++) {
          const a = distinct[i]
          const b = distinct[j]
          if (a === undefined || b === undefined) continue
          bump(pairs, a, b)
          bump(pairs, b, a)
        }
      }
    }
  }

  const churn: Record<string, number> = {}
  for (const f of [...churnMap.keys()].sort()) churn[f] = churnMap.get(f) ?? 0

  const cochange: Record<string, [string, number][]> = {}
  for (const f of [...pairs.keys()].sort()) {
    const partners = [...(pairs.get(f) ?? new Map<string, number>()).entries()]
      .filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, 10)
    if (partners.length > 0) cochange[f] = partners
  }

  const perFile = new Map<string, FileGitInfo>()
  for (const f of Object.keys(churn)) {
    perFile.set(f, { lastTs: lastTs.get(f) ?? 0, commits: churn[f] ?? 0 })
  }

  return { shard: { recent, churn, cochange }, perFile }
}

function bump(pairs: Map<string, Map<string, number>>, a: string, b: string): void {
  let m = pairs.get(a)
  if (!m) {
    m = new Map()
    pairs.set(a, m)
  }
  m.set(b, (m.get(b) ?? 0) + 1)
}

export function headCommit(root: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    return null
  }
}
