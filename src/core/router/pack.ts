import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens, splitIdentifier, tokenizeTask } from '../tokens'
import type { ContextPack, LoadedIndex, PackExcerpt, PackFile, ScoredFile, SessionState, SymbolRecord } from '../types'
import { renderPack } from './render'
import { scoreFiles } from './score'

export interface PackOptions {
  budget: number
  withExcerpts?: boolean
  root?: string
  redact?: (s: string) => string
  nowSec?: number
}

const MATCH_RE = /^matches '([^']+)'/

function matchedTokens(files: ScoredFile[]): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    for (const r of f.reasons) {
      const m = MATCH_RE.exec(r.reason)
      if (m?.[1] !== undefined) out.add(m[1])
    }
  }
  return out
}

/** Exported symbols of a file, ranked: task-token name match > sub-token match, then line. */
function topSymbols(path: string, idx: LoadedIndex, tokenSet: Set<string>): SymbolRecord[] {
  const syms = idx.symbols.symbols.filter((s) => s.f === path && s.x)
  const rank = (s: SymbolRecord): number =>
    tokenSet.has(s.n.toLowerCase()) ? 2 : splitIdentifier(s.n).some((t) => tokenSet.has(t)) ? 1 : 0
  return [...syms].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return rb - ra
    // among exact-name matches, a longer name = more specific token matched
    if (ra === 2 && a.n.length !== b.n.length) return b.n.length - a.n.length
    return a.l - b.l || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)
  })
}

export function buildPack(
  task: string,
  idx: LoadedIndex,
  state: SessionState | null,
  opts: PackOptions,
): ContextPack {
  const tokens = tokenizeTask(task)
  const scored = scoreFiles(tokens, idx, state, opts.nowSec)
  const tokenSet = new Set(tokens.map((t) => t.t))
  const top = scored[0]

  const top3Matched = matchedTokens(scored.slice(0, 3))
  let confidence: ContextPack['confidence'] = 'low'
  if (top && top.score >= 70 && top3Matched.size >= 2) confidence = 'high'
  else if (top && top.score >= 40) confidence = 'medium'

  const selected = scored.slice(0, 8)
  const allMatched = matchedTokens(selected)
  const unmatched = tokens
    .filter((t) => !allMatched.has(t.t))
    .sort((a, b) => b.q - a.q || b.t.length - a.t.length || (a.t < b.t ? -1 : 1))

  const candFiles: PackFile[] = selected.map((sf) => {
    const rec = idx.files.files[sf.path]
    const why = sf.reasons
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.points - a.r.points || a.i - b.i)
      .slice(0, 3)
      .map((x) => x.r.reason)
    const symbols = topSymbols(sf.path, idx, tokenSet)
      .slice(0, 3)
      .map((s) => `${s.sig} [${s.f}:${s.l}]`)
    return {
      path: sf.path,
      score: sf.score,
      why,
      symbols,
      tests: rec?.tests ?? [],
      risk: rec?.risk ?? [],
    }
  })

  const unmatchedHigh = unmatched.filter((t) => t.q >= 2)
  let missing: string | undefined
  if (confidence === 'low' || unmatchedHigh.length > 0) {
    const list = (confidence === 'low' ? unmatched : unmatchedHigh).slice(0, 5).map((t) => t.t)
    const names = list.length > 0 ? list : tokens.slice(0, 5).map((t) => t.t)
    if (names.length > 0) {
      missing = `No strong match for: ${names.join(', ')} — the index may not cover these terms`
    }
  }

  let nextStep: string | undefined
  if (confidence !== 'high') {
    const u = unmatched[0]
    if (u) nextStep = `Try mcp__ctx__symbol_search('${u.t}')`
    else if (top) nextStep = `Read ${top.path} first`
  }

  let excerpt: PackExcerpt | undefined
  if (opts.withExcerpts && opts.root !== undefined && top && top.score >= 80) {
    const best = topSymbols(top.path, idx, tokenSet)[0]
    const startLine = Math.max(1, (best?.l ?? 3) - 2)
    try {
      const raw = readFileSync(join(opts.root, top.path), 'utf8')
      const slice = raw.split('\n').slice(startLine - 1, startLine - 1 + 12)
      if (slice.length > 0) {
        let text = slice.join('\n')
        if (opts.redact) text = opts.redact(text)
        excerpt = { path: top.path, lines: `${startLine}-${startLine + slice.length - 1}`, text }
      }
    } catch {
      // fail open: no excerpt if the file is unreadable
    }
  }

  const pack: ContextPack = {
    task,
    confidence,
    tokensUsed: 0,
    budget: opts.budget,
    files: [],
    depLinks: [],
    excerpts: [],
    missing,
    nextStep,
    alreadyInspected: [],
  }
  const syncInspected = (): void => {
    pack.alreadyInspected = state
      ? pack.files.map((f) => f.path).filter((p) => (state.reads[p] ?? 0) > 0)
      : []
  }
  // greedy assembly measured against the full render (footer fields included up
  // front, so the budget check is exact rather than a blind reserve)
  const fits = (): boolean => estimateTokens(renderPack(pack)) <= opts.budget

  for (const f of candFiles) {
    pack.files.push(f)
    syncInspected()
    if (!fits()) {
      pack.files.pop()
      syncInspected()
      break
    }
  }

  const included = new Set(pack.files.map((f) => f.path))
  const depCands: string[] = []
  for (const f of pack.files) {
    for (const b of idx.graph.fwd[f.path] ?? []) {
      if (included.has(b) && depCands.length < 6) depCands.push(`${f.path} → ${b}`)
    }
  }
  for (const d of depCands) {
    pack.depLinks.push(d)
    if (!fits()) {
      pack.depLinks.pop()
      break
    }
  }

  if (excerpt && included.has(excerpt.path)) {
    pack.excerpts.push(excerpt)
    if (!fits()) pack.excerpts.pop()
  }

  // last-resort trims so the header always fits, even on tiny budgets
  while (!fits() && pack.depLinks.length > 0) pack.depLinks.pop()
  while (!fits() && pack.files.length > 0) {
    pack.files.pop()
    syncInspected()
  }
  if (!fits()) {
    delete pack.missing
    delete pack.nextStep
  }
  pack.tokensUsed = estimateTokens(renderPack(pack))
  return pack
}
