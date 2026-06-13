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

// BM25F: each file is a multi-field document. Field boosts act as within-field
// term frequencies; a term present in several fields sums their boosts. One BM25
// saturation (k1) + length normalization (b) is then applied. Document length is
// the weighted field size, so symbol-dense files get length-normalized down —
// the BM25 cure for "huge file matches everything".
const BM25_K1 = 1.5
const BM25_B = 0.75
const F_NAME = 5 // basename
const F_EXPORT = 4 // exported/pub symbol name
const F_SEG = 3 // path segment
const F_SYM = 2 // any symbol sub-token
const F_HEAD = 1.5 // doc heading
const F_PATHSUB = 1 // fuzzy path substring (fallback)

interface TermHit {
  /** BM25F field-weighted term frequency */
  tf: number
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
  /** weighted document length (Σ fieldBoost · fieldSize) for BM25 length norm */
  docLen: number
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
  const segs = new Set(path.toLowerCase().split('/'))
  const baseJoined = splitIdentifier(baseSansExt).join('')
  const nameSize = baseJoined.length > 0 && baseJoined !== baseSansExt.toLowerCase() ? 2 : 1
  const docLen =
    F_NAME * nameSize +
    F_EXPORT * exactSyms.size +
    F_SEG * segs.size +
    F_SYM * subSyms.size +
    F_HEAD * headSubs.size
  return {
    path,
    rec,
    base: baseSansExt.toLowerCase(),
    baseJoined,
    segs,
    pathLower: path.toLowerCase(),
    exactSyms,
    subSyms,
    headSubs,
    docLen,
  }
}

/** BM25F field-weighted term frequency of t in a file (sum across fields it hits),
 * plus the strongest field for the human-readable reason. Null if absent. */
function termMatch(t: string, ctx: FileCtx): TermHit | null {
  let tf = 0
  let bestBoost = 0
  let reason = ''
  const consider = (boost: number, r: string) => {
    tf += boost
    if (boost > bestBoost) {
      bestBoost = boost
      reason = r
    }
  }
  if (t === ctx.base || (ctx.baseJoined.length > 0 && t === ctx.baseJoined)) {
    consider(F_NAME, `matches '${t}' in filename`)
  }
  const exact = ctx.exactSyms.get(t)
  if (exact !== undefined) consider(F_EXPORT, `matches '${t}' in exported symbol ${exact}`)
  if (ctx.segs.has(t)) consider(F_SEG, `matches '${t}' in path segment`)
  const sub = ctx.subSyms.get(t)
  if (sub !== undefined) consider(F_SYM, `matches '${t}' in symbol ${sub}`)
  const head = ctx.headSubs.get(t)
  if (head !== undefined) consider(F_HEAD, `matches '${t}' in doc heading "${head}"`)
  if (tf === 0 && t.length >= 4 && ctx.pathLower.includes(t)) {
    consider(F_PATHSUB, `matches '${t}' in path`)
  }
  return tf > 0 ? { tf, reason } : null
}

/** BM25 inverse document frequency (always-positive variant). */
function bm25Idf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
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

  // one sweep: per-(token,file) field-weighted tf, df per token, and the corpus
  // average document length needed for BM25 length normalization.
  const ctxs: FileCtx[] = []
  const hits: (TermHit | null)[][] = []
  const ctxByPath = new Map<string, FileCtx>()
  const df = new Array<number>(taskTokens.length).fill(0)
  let totalDocLen = 0
  for (const p of paths) {
    const rec = idx.files.files[p]
    if (!rec) continue
    const ctx = buildCtx(p, rec, symsByFile.get(p) ?? [])
    totalDocLen += ctx.docLen
    const row: (TermHit | null)[] = []
    for (let i = 0; i < taskTokens.length; i++) {
      const tt = taskTokens[i]
      const h = tt ? termMatch(tt.t, ctx) : null
      row.push(h)
      if (h) df[i] = (df[i] ?? 0) + 1
    }
    ctxs.push(ctx)
    hits.push(row)
    ctxByPath.set(p, ctx)
  }

  const avgdl = totalDocLen / N || 1
  // per-token IDF × query weight (alias tokens carry reduced q)
  const idfq = taskTokens.map((tt, i) => bm25Idf(df[i] ?? 0, N) * tt.q)

  // stage 1: BM25F lexical score per file
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
    const row = hits[fi]
    if (!ctx || !row) continue
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * (ctx.docLen / avgdl))
    let L = 0
    const tokenReasons: ScoreReason[] = []
    for (let i = 0; i < row.length; i++) {
      const h = row[i]
      if (!h) continue
      const contrib = (idfq[i] ?? 0) * ((h.tf * (BM25_K1 + 1)) / (h.tf + norm))
      L += contrib
      tokenReasons.push({ reason: h.reason, points: round1(contrib) })
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
    // scale raw BM25 term contributions into the same 0-100 space as the boosts
    // so reasons sort comparably (a strong lexical hit outranks a +15 recency).
    const scale = maxL > 0 ? 100 / maxL : 0
    const wrk: Work = {
      path: ctx.path,
      rec,
      lhat: maxL > 0 ? raw.L / maxL : 0,
      tokenReasons: raw.tokenReasons.map((r) => ({ reason: r.reason, points: round1(r.points * scale) })),
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
      // BM25's tf-saturation compresses the score gap, so a generated file that
      // shares a strong term can score high; bury it harder than the linear scheme did.
      if (rec.risk.includes('generated')) wrk.penalties.push({ reason: 'generated file', points: -75 })
      if (rec.risk.includes('vendor')) wrk.penalties.push({ reason: 'vendor file', points: -90 })
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
