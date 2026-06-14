import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { latestSessionId, parseSessionLog, readSession } from '../../core/memory/log'
import { sessionsDir } from '../../core/paths'
import type { SessionEvent } from '../../core/types'
import { out, parseCommon } from '../shared'

/**
 * Session-level token accounting — the complement to `ctx eval` (which measures
 * retrieval ranking only). It reads the per-session event logs that the hooks
 * write and answers: did claude-ctx reduce the total tokens a session spends?
 *
 *   ctx bench-session [<sessionId>]                analyze one session (default: latest)
 *   ctx bench-session --all                        aggregate every session of this repo
 *   ctx bench-session --dir <path>                 aggregate every *.jsonl in a directory
 *   ctx bench-session --baseline <dir> --treatment <dir>   A/B diff + net_saved
 *
 * A/B protocol: run the same task corpus once with `inject.shadow=true` (baseline,
 * "no help") and once with injection on (treatment), archiving the sessions dir
 * each time, then diff the two archives.
 */

interface Agg {
  prompts: number
  toolCalls: number
  filesRead: number
  readTokens: number
  bashOutputTokens: number
  mcpResultTokens: number
  tokensInjected: number
  packs: number
  packsInjected: number
  high: number
  medium: number
  low: number
  overlapSum: number
  overlapN: number
}

function blank(): Agg {
  return {
    prompts: 0,
    toolCalls: 0,
    filesRead: 0,
    readTokens: 0,
    bashOutputTokens: 0,
    mcpResultTokens: 0,
    tokensInjected: 0,
    packs: 0,
    packsInjected: 0,
    high: 0,
    medium: 0,
    low: 0,
    overlapSum: 0,
    overlapN: 0,
  }
}

/** Roll one session's events into metrics, including pack-overlap@5 — the share
 * of the files the model read in a prompt's window that the pack's top-5 named. */
function analyze(events: SessionEvent[]): Agg {
  const a = blank()
  const distinctReads = new Set<string>()
  let winTop5: Set<string> | null = null
  let winReads: Set<string> | null = null
  const closeWindow = () => {
    if (winTop5 && winReads && winReads.size > 0) {
      let hit = 0
      for (const f of winReads) if (winTop5.has(f)) hit++
      a.overlapSum += hit / Math.min(5, winReads.size)
      a.overlapN += 1
    }
  }
  for (const ev of events) {
    switch (ev.e) {
      case 'prompt':
        a.prompts += 1
        break
      case 'read':
        a.toolCalls += 1
        distinctReads.add(ev.f)
        if (typeof ev.tok === 'number') a.readTokens += ev.tok
        if (winReads) winReads.add(ev.f)
        break
      case 'bash':
        a.toolCalls += 1
        if (typeof ev.outTok === 'number') a.bashOutputTokens += ev.outTok
        break
      case 'mcp':
        a.toolCalls += 1
        if (typeof ev.outTok === 'number') a.mcpResultTokens += ev.outTok
        break
      case 'edit':
        a.toolCalls += 1
        break
      case 'pack':
        closeWindow() // the previous prompt's window ends when the next pack starts
        a.packs += 1
        a[ev.confidence] += 1
        if (ev.injected) {
          a.packsInjected += 1
          a.tokensInjected += ev.tok
        }
        winTop5 = new Set(ev.files.slice(0, 5))
        winReads = new Set()
        break
      case 'overview':
        if (ev.injected) a.tokensInjected += ev.tok
        break
    }
  }
  closeWindow()
  a.filesRead = distinctReads.size
  return a
}

function combine(list: Agg[]): Agg {
  const c = blank()
  for (const a of list) for (const k of Object.keys(c) as (keyof Agg)[]) c[k] += a[k]
  return c
}

/** Load every `*.jsonl` in a directory as one Agg each. */
function loadDir(dir: string): Agg[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const aggs: Agg[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.jsonl')) continue
    try {
      aggs.push(analyze(parseSessionLog(readFileSync(join(dir, n), 'utf8'))))
    } catch {
      /* skip unreadable */
    }
  }
  return aggs
}

const round = (n: number): string => Math.round(n).toString()
const mean = (total: number, n: number): string => (n > 0 ? (total / n).toFixed(1) : '0')

function describe(label: string, aggs: Agg[]): void {
  const n = aggs.length
  const t = combine(aggs)
  out(`\n=== bench-session: ${label} (${n} session${n === 1 ? '' : 's'}) ===`)
  const row = (name: string, total: number) =>
    out(`  ${name.padEnd(24)} ${round(total).padStart(9)}   (mean ${mean(total, n)}/session)`)
  row('prompts', t.prompts)
  row('tool calls', t.toolCalls)
  row('files read (distinct)', t.filesRead)
  row('read tokens', t.readTokens)
  row('bash output tokens', t.bashOutputTokens)
  row('mcp result tokens', t.mcpResultTokens)
  row('tokens injected', t.tokensInjected)
  out(
    `  ${'packs'.padEnd(24)} ${round(t.packs).padStart(9)}   ` +
      `(high ${t.high} / medium ${t.medium} / low ${t.low}; injected ${t.packsInjected})`,
  )
  const overlap = t.overlapN > 0 ? (t.overlapSum / t.overlapN).toFixed(2) : 'n/a'
  out(`  ${'pack overlap@5'.padEnd(24)} ${overlap.padStart(9)}   (${t.overlapN} window${t.overlapN === 1 ? '' : 's'})`)
}

function abReport(base: Agg[], treat: Agg[]): void {
  const b = combine(base)
  const t = combine(treat)
  out('\n=== A/B: baseline (shadow / no help) vs treatment (injection on) ===')
  out(`  ${'metric'.padEnd(22)} ${'baseline'.padStart(10)} ${'treatment'.padStart(11)} ${'delta'.padStart(9)}`)
  const row = (name: string, bv: number, tv: number) =>
    out(`  ${name.padEnd(22)} ${round(bv).padStart(10)} ${round(tv).padStart(11)} ${round(tv - bv).padStart(9)}`)
  row('read tokens', b.readTokens, t.readTokens)
  row('bash output tokens', b.bashOutputTokens, t.bashOutputTokens)
  row('mcp result tokens', b.mcpResultTokens, t.mcpResultTokens)
  row('tokens injected', b.tokensInjected, t.tokensInjected)
  const netSaved =
    b.readTokens + b.bashOutputTokens - (t.readTokens + t.bashOutputTokens + t.tokensInjected + t.mcpResultTokens)
  out(`  ${'-'.repeat(54)}`)
  out(`  net_saved (total)      ${round(netSaved).padStart(10)}   (> 0 ⇒ injection cheaper over the corpus)`)
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, {
    session: { type: 'string' },
    dir: { type: 'string' },
    baseline: { type: 'string' },
    treatment: { type: 'string' },
    all: { type: 'boolean' },
  })

  const baseline = typeof a.values.baseline === 'string' ? a.values.baseline : undefined
  const treatment = typeof a.values.treatment === 'string' ? a.values.treatment : undefined
  if (baseline || treatment) {
    if (!baseline || !treatment) {
      process.stderr.write('Both --baseline <dir> and --treatment <dir> are required for A/B.\n')
      return 1
    }
    const base = loadDir(baseline)
    const treat = loadDir(treatment)
    if (base.length === 0 || treat.length === 0) {
      process.stderr.write('No .jsonl session logs found in baseline and/or treatment dir.\n')
      return 1
    }
    if (a.json) {
      out(JSON.stringify({ baseline: combine(base), treatment: combine(treat) }, null, 2))
      return 0
    }
    describe(`baseline ${baseline}`, base)
    describe(`treatment ${treatment}`, treat)
    abReport(base, treat)
    return 0
  }

  const dir = typeof a.values.dir === 'string' ? a.values.dir : undefined
  if (dir) {
    const aggs = loadDir(dir)
    if (aggs.length === 0) {
      process.stderr.write(`No .jsonl session logs found in ${dir}\n`)
      return 1
    }
    if (a.json) {
      out(JSON.stringify(combine(aggs), null, 2))
      return 0
    }
    describe(dir, aggs)
    return 0
  }

  if (a.values.all === true) {
    const aggs = loadDir(sessionsDir(a.repo))
    if (aggs.length === 0) {
      process.stderr.write('No sessions recorded for this repo.\n')
      return 1
    }
    if (a.json) {
      out(JSON.stringify(combine(aggs), null, 2))
      return 0
    }
    describe('all sessions', aggs)
    return 0
  }

  const id = (typeof a.values.session === 'string' ? a.values.session : a.positionals[0]) ?? latestSessionId(a.repo)
  if (!id) {
    process.stderr.write('No sessions recorded for this repo.\n')
    return 1
  }
  const agg = analyze(readSession(a.repo, id))
  if (a.json) {
    out(JSON.stringify({ id, ...agg }, null, 2))
    return 0
  }
  describe(`session ${id}`, [agg])
  return 0
}
