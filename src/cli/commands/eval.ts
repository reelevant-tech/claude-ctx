import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '../../core/config'
import { loadEmbedder } from '../../core/embed/embedder'
import { semanticScores } from '../../core/embed/query'
import { dot, unpackVector } from '../../core/embed/vectors'
import { gitTopLevel } from '../../core/git'
import { buildPack } from '../../core/router/pack'
import { loadIndex, loadShard } from '../../core/store/shards'
import type { VectorsShard } from '../../core/types'
import { out, parseCommon } from '../shared'

interface EvalQuery {
  query: string
  /** repo root (abs path) or name resolvable via --repo default */
  repo?: string
  /** path/symbol substrings that count as a correct hit (case-insensitive) */
  expect?: string[]
}

function hitRank(paths: string[], expect: string[] | undefined): number {
  if (!expect || expect.length === 0) return -1
  const lc = expect.map((e) => e.toLowerCase())
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!.toLowerCase()
    if (lc.some((e) => p.includes(e))) return i + 1
  }
  return 0 // miss
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { k: { type: 'string' }, file: { type: 'string' } })
  const file = typeof a.values.file === 'string' ? a.values.file : a.positionals[0]
  if (!file) {
    process.stderr.write('Usage: ctx eval <queries.json> [--k 8]\n')
    return 1
  }
  const k = typeof a.values.k === 'string' ? Number(a.values.k) : 8
  let queries: EvalQuery[]
  try {
    queries = JSON.parse(readFileSync(resolve(file), 'utf8')) as EvalQuery[]
  } catch (e) {
    process.stderr.write(`Cannot read ${file}: ${e instanceof Error ? e.message : e}\n`)
    return 1
  }

  const agg = { lexical: 0, hybrid: 0, vector: 0, scored: 0 }
  for (const q of queries) {
    const root = q.repo ? gitTopLevel(q.repo) ?? resolve(q.repo) : a.repo
    const idx = loadIndex(root)
    out(`\n## "${q.query}"  [${root.split('/').pop()}]`)
    if (!idx) {
      out('  (no index — run ctx index)')
      continue
    }
    const cfg = loadConfig(root)
    const sem = await semanticScores(root, q.query, cfg)

    const lexPack = buildPack(q.query, idx, null, { budget: 4000 })
    const hybPack = buildPack(q.query, idx, null, {
      budget: 4000,
      semantic: sem?.scores,
      semanticSymbols: sem?.symbols,
      semWeight: cfg.embeddings.weight,
    })
    const lexPaths = lexPack.files.map((f) => f.path).slice(0, k)
    const hybPaths = hybPack.files.map((f) => f.path).slice(0, k)

    // pure vector: top-k symbol chunks
    const vecPaths: string[] = []
    const vecLabels: string[] = []
    const shard = loadShard<VectorsShard>(root, 'vectors')
    if (shard && Array.isArray(shard.entries) && shard.entries.length > 0) {
      const embedder = await loadEmbedder(cfg)
      if (embedder && embedder.model === shard.model) {
        const [qv] = await embedder.embed([q.query])
        if (qv && qv.length === shard.dim) {
          const scored = shard.entries
            .map((e) => ({ e, cos: dot(qv, unpackVector(e.vec, shard.dim)) }))
            .sort((x, y) => y.cos - x.cos)
            .slice(0, k)
          for (const s of scored) {
            vecPaths.push(s.e.path)
            vecLabels.push(`${s.cos.toFixed(2)} ${s.e.path}${s.e.symbol ? `#${s.e.symbol}` : ''}`)
          }
        }
      }
    }

    const fmt = (label: string, paths: string[], extra?: string[]) => {
      out(`  ${label}:`)
      const lines = extra ?? paths
      for (const l of lines.slice(0, k)) out(`    ${l}`)
    }
    fmt('lexical', lexPaths)
    fmt('hybrid ', hybPaths, hybPack.files.slice(0, k).map((f) => `${f.path}${f.why.some((w) => w.includes('semantically')) ? '  [sem]' : ''}`))
    if (vecLabels.length) fmt('vector ', vecPaths, vecLabels)

    if (q.expect && q.expect.length) {
      agg.scored++
      const lr = hitRank(lexPaths, q.expect)
      const hr = hitRank(hybPaths, q.expect)
      const vr = hitRank(vecPaths, q.expect)
      if (lr > 0) agg.lexical++
      if (hr > 0) agg.hybrid++
      if (vr > 0) agg.vector++
      out(`  expect=${q.expect.join('|')}  rank(lex=${lr <= 0 ? 'MISS' : lr}, hyb=${hr <= 0 ? 'MISS' : hr}, vec=${vr <= 0 ? 'MISS' : vr})`)
    }
  }

  if (agg.scored > 0) {
    out(`\n=== hit@${k} over ${agg.scored} labelled queries ===`)
    out(`  lexical: ${agg.lexical}/${agg.scored}`)
    out(`  hybrid:  ${agg.hybrid}/${agg.scored}`)
    out(`  vector:  ${agg.vector}/${agg.scored}`)
  }
  return 0
}
