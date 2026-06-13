import type { VectorsShard } from '../types'

/** Pack an L2-normalized vector as base64 of its Float32 bytes. */
export function packVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}

export function unpackVector(b64: string, dim: number): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  // copy into an aligned Float32Array (base64 buffer offset may be unaligned)
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = buf.readFloatLE(i * 4)
  return out
}

/** Dot product (== cosine for L2-normalized vectors). */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

export interface SemanticHit {
  /** best cosine across the file's chunks */
  scores: Map<string, number>
  /** the symbol whose chunk gave the file its best score (if it was a symbol chunk) */
  symbols: Map<string, string>
}

/** Score every chunk against the query, aggregating to a per-file max (with the
 * winning symbol). Aggregation keeps the existing per-file router fusion intact
 * while benefiting from symbol-level granularity. */
export function scoreEntries(query: Float32Array, shard: VectorsShard): SemanticHit {
  const scores = new Map<string, number>()
  const symbols = new Map<string, string>()
  for (const e of shard.entries) {
    const cos = dot(query, unpackVector(e.vec, shard.dim))
    const prev = scores.get(e.path)
    if (prev === undefined || cos > prev) {
      scores.set(e.path, cos)
      if (e.symbol) symbols.set(e.path, e.symbol)
      else symbols.delete(e.path)
    }
  }
  return { scores, symbols }
}
