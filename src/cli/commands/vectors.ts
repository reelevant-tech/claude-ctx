import { loadConfig } from '../../core/config'
import { loadEmbedder } from '../../core/embed/embedder'
import { dot, unpackVector } from '../../core/embed/vectors'
import { loadShard } from '../../core/store/shards'
import type { SymbolKind, VectorsShard } from '../../core/types'
import { out, parseCommon } from '../shared'

/** `ctx vectors` — shard stats; `ctx vectors "<query>"` — nearest symbol chunks. */
export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { limit: { type: 'string' } })
  const shard = loadShard<VectorsShard>(a.repo, 'vectors')
  if (!shard || !Array.isArray(shard.entries) || shard.entries.length === 0) {
    out('No vectors (or pre-upgrade shard). Run: ctx index')
    return 0
  }

  const query = a.positionals.join(' ').trim()
  if (!query) {
    // stats
    const fileSet = new Set(shard.entries.map((e) => e.path))
    const byKind: Record<string, number> = {}
    let fileLevel = 0
    for (const e of shard.entries) {
      if (e.symbol) byKind[e.kind ?? 'symbol'] = (byKind[e.kind ?? 'symbol'] ?? 0) + 1
      else fileLevel++
    }
    const dimOk = shard.entries.every((e) => Buffer.from(e.vec, 'base64').length === shard.dim * 4)
    if (a.json) {
      out(JSON.stringify({ model: shard.model, dim: shard.dim, createdAt: shard.createdAt, headCommit: shard.headCommit, files: fileSet.size, entries: shard.entries.length, fileLevel, byKind, dimConsistent: dimOk }, null, 2))
      return 0
    }
    out(`model: ${shard.model}  dim: ${shard.dim}  dimConsistent: ${dimOk}`)
    out(`built: ${new Date(shard.createdAt * 1000).toISOString()}${shard.headCommit ? `  @ ${shard.headCommit.slice(0, 8)}` : ''}`)
    out(`files: ${fileSet.size}  entries: ${shard.entries.length}  (file-level: ${fileLevel})`)
    out(`symbol chunks by kind: ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(', ') || '(none)'}`)
    return 0
  }

  // nearest search
  const cfg = loadConfig(a.repo)
  const embedder = await loadEmbedder(cfg)
  if (!embedder) {
    out('Embedder unavailable (run ctx embed-setup).')
    return 1
  }
  if (embedder.model !== shard.model) {
    out(`Model mismatch: shard=${shard.model} embedder=${embedder.model}. Re-run ctx index.`)
    return 1
  }
  const [qv] = await embedder.embed([query])
  if (!qv || qv.length !== shard.dim) {
    out('Query embedding failed or dimension mismatch.')
    return 1
  }
  const limit = typeof a.values.limit === 'string' ? Number(a.values.limit) : 12
  const scored = shard.entries
    .map((e) => ({ e, cos: dot(qv, unpackVector(e.vec, shard.dim)) }))
    .sort((x, y) => y.cos - x.cos)
    .slice(0, limit)
  if (a.json) {
    out(JSON.stringify(scored.map((s) => ({ cos: s.cos, path: s.e.path, symbol: s.e.symbol, kind: s.e.kind, startLine: s.e.startLine })), null, 2))
    return 0
  }
  out(`Nearest chunks for "${query}":`)
  for (const { e, cos } of scored) {
    const loc = e.symbol ? `${e.kind as SymbolKind} ${e.symbol}` : '(file)'
    out(`  ${cos.toFixed(3)}  ${e.path}:${e.startLine}  ${loc}`)
  }
  return 0
}
