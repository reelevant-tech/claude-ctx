import { splitIdentifier } from '../tokens'
import type { TaskToken } from '../tokens'
import type { FileRecord, LoadedIndex, ScoreReason, ScoredFile, SessionState, SymbolRecord } from '../types'

const DAY = 86400

/** Tokens that waive generated/vendor/infra penalties (the task is *about* that domain). */
const RISK_VOCAB = new Set([
  'docker', 'deploy', 'ci', 'cd', 'migration', 'migrations', 'terraform', 'k8s', 'kubernetes',
  'helm', 'workflow', 'pipeline', 'infra', 'env', 'dockerfile', 'compose', 'jenkins', 'lock',
])

const round1 = (n: number): number => Math.round(n * 10) / 10

interface Match {
  pts: number
  reason: string
}

interface FileCtx {
  path: string
  rec: FileRecord
  base: string
  baseJoined: string
  segs: Set<string>
  pathLower: string
  /** lowercased exported name -> original name */
  exactSyms: Map<string, string>
  /** sub-token -> owning symbol name */
  subSyms: Map<string, string>
  /** sub-token -> heading text */
  headSubs: Map<string, string>
}

function buildCtx(path: string, rec: FileRecord, syms: SymbolRecord[]): FileCtx {
  const baseFull = path.split('/').pop() ?? path
  const baseSansExt = baseFull.replace(/\.[^.]+$/, '')
  const exactSyms = new Map<string, string>()
  for (const s of syms) {
    if (!s.x) continue
    const k = s.n.toLowerCase()
    if (!exactSyms.has(k)) exactSyms.set(k, s.n)
  }
  for (const e of rec.exports) {
    const k = e.toLowerCase()
    if (!exactSyms.has(k)) exactSyms.set(k, e)
  }
  const subSyms = new Map<string, string>()
  const names: string[] = []
  for (const s of syms) names.push(s.n)
  for (const e of rec.exports) names.push(e)
  for (const n of names) {
    for (const sub of splitIdentifier(n)) if (!subSyms.has(sub)) subSyms.set(sub, n)
  }
  const headSubs = new Map<string, string>()
  for (const h of rec.docHeadings) {
    for (const sub of splitIdentifier(h)) if (!headSubs.has(sub)) headSubs.set(sub, h)
  }
  return {
    path,
    rec,
    base: baseSansExt.toLowerCase(),
    baseJoined: splitIdentifier(baseSansExt).join(''),
    segs: new Set(path.toLowerCase().split('/')),
    pathLower: path.toLowerCase(),
    exactSyms,
    subSyms,
    headSubs,
  }
}

/** Best single match of token t against a file, checked strongest-first. */
function bestMatch(t: string, ctx: FileCtx): Match | null {
  if (t === ctx.base || (ctx.baseJoined.length > 0 && t === ctx.baseJoined)) {
    return { pts: 5.0, reason: `matches '${t}' in filename` }
  }
  const exact = ctx.exactSyms.get(t)
  if (exact !== undefined) return { pts: 4.0, reason: `matches '${t}' in exported symbol ${exact}` }
  if (ctx.segs.has(t)) return { pts: 3.0, reason: `matches '${t}' in path segment` }
  const sub = ctx.subSyms.get(t)
  if (sub !== undefined) return { pts: 2.0, reason: `matches '${t}' in symbol ${sub}` }
  const head = ctx.headSubs.get(t)
  if (head !== undefined) return { pts: 1.5, reason: `matches '${t}' in doc heading "${head}"` }
  if (t.length >= 4 && ctx.pathLower.includes(t)) return { pts: 1.0, reason: `matches '${t}' in path` }
  return null
}

interface Work {
  path: string
  rec: FileRecord
  lhat: number
  tokenReasons: ScoreReason[]
  recency?: ScoreReason
  entry?: ScoreReason
  centrality?: ScoreReason
  inspected?: ScoreReason
  semantic?: ScoreReason
  penalties: ScoreReason[]
  /** pass-1 score (stage1 + non-relational boosts - penalties) */
  base: number
}

// Hybrid semantic fusion is QUERY-RELATIVE. Absolute cosines from a small
// sentence model vary wildly by query (~0.16 for a pure paraphrase, ~0.48 when
// the query shares code vocabulary), so thresholds can't be absolute — we
// normalize each file's cosine against this query's max/mean and only engage
// when there's a meaningful top signal and spread.
const SEM_MAX_POINTS = 80 // contribution of the single best semantic match (before weight)
const SEM_MIN_MAXCOS = 0.15 // skip semantic entirely if nothing clears this (model cosines are compressed)
const SEM_MIN_SPREAD = 0.03 // ...or if every file is equally (un)related
const SEM_CAND_NORM = 0.6 // a file with no lexical hit must reach this normalized similarity to enter

interface SemStats {
  active: boolean
  norm: (cos: number) => number
}

function semStatsOf(semantic: Map<string, number> | undefined): SemStats {
  if (!semantic || semantic.size === 0) return { active: false, norm: () => 0 }
  let mx = 0
  let sum = 0
  for (const v of semantic.values()) {
    if (v > mx) mx = v
    sum += v
  }
  const mean = sum / semantic.size
  const denom = Math.max(0.01, mx - mean)
  const active = mx >= SEM_MIN_MAXCOS && mx - mean >= SEM_MIN_SPREAD
  return { active, norm: (c) => Math.max(0, Math.min(1, (c - mean) / denom)) }
}

export function scoreFiles(
  taskTokens: TaskToken[],
  idx: LoadedIndex,
  state: SessionState | null,
  nowSec?: number,
  semantic?: Map<string, number>,
  semWeight = 0.5,
  semanticSymbols?: Map<string, string>,
): ScoredFile[] {
  const now = nowSec ?? Math.floor(Date.now() / 1000)
  // semantic can carry retrieval even with no lexical tokens (e.g. paraphrase)
  if (taskTokens.length === 0 && !semantic) return []
  const paths = Object.keys(idx.files.files).sort()
  const N = paths.length
  if (N === 0) return []

  const sem = semStatsOf(semantic)

  const symsByFile = new Map<string, SymbolRecord[]>()
  for (const s of idx.symbols.symbols) {
    const arr = symsByFile.get(s.f)
    if (arr) arr.push(s)
    else symsByFile.set(s.f, [s])
  }

  // all (token, file) matches in one sweep — df derives from the same matches that score
  const ctxs: FileCtx[] = []
  const matches: (Match | null)[][] = []
  const ctxByPath = new Map<string, FileCtx>()
  const df = new Array<number>(taskTokens.length).fill(0)
  for (const p of paths) {
    const rec = idx.files.files[p]
    if (!rec) continue
    const ctx = buildCtx(p, rec, symsByFile.get(p) ?? [])
    const row: (Match | null)[] = []
    for (let i = 0; i < taskTokens.length; i++) {
      const tt = taskTokens[i]
      const m = tt ? bestMatch(tt.t, ctx) : null
      row.push(m)
      if (m) df[i] = (df[i] ?? 0) + 1
    }
    ctxs.push(ctx)
    matches.push(row)
    ctxByPath.set(p, ctx)
  }

  const w = taskTokens.map((tt, i) => (1 + Math.log(N / Math.max(1, df[i] ?? 0))) * tt.q)

  // stage 1: lexical score
  interface Raw {
    ctx: FileCtx
    L: number
    tokenReasons: ScoreReason[]
  }
  const raws: Raw[] = []
  const inRaws = new Set<string>()
  let maxL = 0
  for (let fi = 0; fi < ctxs.length; fi++) {
    const ctx = ctxs[fi]
    const row = matches[fi]
    if (!ctx || !row) continue
    let L = 0
    const tokenReasons: ScoreReason[] = []
    for (let i = 0; i < row.length; i++) {
      const m = row[i]
      if (!m) continue
      const contrib = (w[i] ?? 0) * m.pts
      L += contrib
      tokenReasons.push({ reason: m.reason, points: round1(contrib) })
    }
    if (L <= 0) continue
    if (L > maxL) maxL = L
    raws.push({ ctx, L, tokenReasons })
    inRaws.add(ctx.path)
  }

  // hybrid: admit files that are semantically similar even with no lexical hit
  if (semantic && sem.active) {
    for (const [path, cos] of semantic) {
      if (inRaws.has(path) || sem.norm(cos) < SEM_CAND_NORM) continue
      const ctx = ctxByPath.get(path)
      if (!ctx) continue
      raws.push({ ctx, L: 0, tokenReasons: [] })
      inRaws.add(path)
    }
  }
  if (raws.length === 0) return []

  const waived = taskTokens.some((tt) => RISK_VOCAB.has(tt.t))

  // pass 1: non-relational boosts + penalties => provisional ranking
  const works: Work[] = raws.map((raw) => {
    const { ctx } = raw
    const rec = ctx.rec
    const wrk: Work = {
      path: ctx.path,
      rec,
      lhat: maxL > 0 ? raw.L / maxL : 0,
      tokenReasons: raw.tokenReasons,
      penalties: [],
      base: 0,
    }
    let s = 100 * wrk.lhat
    if (semantic && sem.active) {
      const norm = sem.norm(semantic.get(ctx.path) ?? 0)
      const pts = round1(semWeight * SEM_MAX_POINTS * norm)
      if (pts > 0) {
        s += pts
        const sym = semanticSymbols?.get(ctx.path)
        wrk.semantic = { reason: sym ? `semantically similar (via ${sym})` : 'semantically similar', points: pts }
      }
    }
    if (rec.git) {
      const age = now - rec.git.lastTs
      const days = Math.max(0, Math.floor(age / DAY))
      if (age <= 7 * DAY) {
        s += 15
        wrk.recency = { reason: `changed ${days}d ago`, points: 15 }
      } else if (age <= 30 * DAY) {
        s += 8
        wrk.recency = { reason: `changed ${days}d ago`, points: 8 }
      }
    }
    if (rec.entry) {
      s += 10
      wrk.entry = { reason: 'entrypoint', points: 10 }
    }
    const c = idx.graph.centrality[ctx.path] ?? 0
    if (c > 0) {
      const pts = Math.min(10, 2 * Math.log2(1 + c))
      s += pts
      wrk.centrality = { reason: `imported by ${c} files`, points: round1(pts) }
    }
    if (state && (state.reads[ctx.path] ?? 0) > 0) {
      s += 4
      wrk.inspected = { reason: 'already inspected this session', points: 4 }
    }
    if (!waived) {
      if (rec.risk.includes('generated')) wrk.penalties.push({ reason: 'generated file', points: -60 })
      if (rec.risk.includes('vendor')) wrk.penalties.push({ reason: 'vendor file', points: -80 })
      if (rec.risk.includes('infra')) wrk.penalties.push({ reason: 'infra file', points: -15 })
    }
    if (rec.risk.includes('huge') || rec.lines > 3000) {
      wrk.penalties.push({ reason: `huge file (${rec.lines} lines)`, points: -10 })
    }
    for (const p of wrk.penalties) s += p.points
    wrk.base = s
    return wrk
  })

  const byRank = (a: { base: number; path: string }, b: { base: number; path: string }): number =>
    b.base - a.base || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const provisional = [...works].sort(byRank)
  const top5Order = provisional.slice(0, 5).map((x) => x.path)
  const top5 = new Set(top5Order)
  const top1 = top5Order[0]

  // pass 2: relational boosts against the provisional top
  const out: ScoredFile[] = []
  for (const wrk of works) {
    let s = wrk.base
    let cochangeR: ScoreReason | undefined
    let testlinkR: ScoreReason | undefined
    let samePkgR: ScoreReason | undefined

    for (const pair of idx.git.cochange[wrk.path] ?? []) {
      const [partner, count] = pair
      if (count >= 3 && partner !== wrk.path && top5.has(partner)) {
        s += 6
        cochangeR = { reason: `co-changes with ${partner}`, points: 6 }
        break
      }
    }

    if (wrk.rec.testedBy !== undefined && top5.has(wrk.rec.testedBy)) {
      testlinkR = { reason: `test of ${wrk.rec.testedBy}`, points: 5 }
    } else {
      let owner: string | undefined
      for (const tp of top5Order) {
        if (tp === wrk.path) continue
        const r = idx.files.files[tp]
        if (r && r.tests.includes(wrk.path)) {
          owner = tp
          break
        }
      }
      if (owner !== undefined) {
        testlinkR = { reason: `test of ${owner}`, points: 5 }
      } else {
        const t = wrk.rec.tests.find((x) => top5.has(x))
        if (t !== undefined) testlinkR = { reason: `tested by ${t}`, points: 5 }
      }
    }
    if (testlinkR) s += 5

    if (top1 !== undefined && wrk.path !== top1 && wrk.rec.pkg !== -1) {
      const r1 = idx.files.files[top1]
      if (r1 && r1.pkg === wrk.rec.pkg) {
        s += 3
        samePkgR = { reason: `same package as ${top1}`, points: 3 }
      }
    }

    const score = round1(s)
    if (score < 25) continue
    const reasons: ScoreReason[] = [...wrk.tokenReasons]
    if (wrk.recency) reasons.push(wrk.recency)
    if (wrk.entry) reasons.push(wrk.entry)
    if (wrk.centrality) reasons.push(wrk.centrality)
    if (cochangeR) reasons.push(cochangeR)
    if (testlinkR) reasons.push(testlinkR)
    if (samePkgR) reasons.push(samePkgR)
    if (wrk.semantic) reasons.push(wrk.semantic)
    if (wrk.inspected) reasons.push(wrk.inspected)
    reasons.push(...wrk.penalties)
    out.push({ path: wrk.path, score, reasons })
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  return out.slice(0, 40)
}
