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

/** path -> cosine similarity against the query vector, for every stored file. */
export function cosineMap(query: Float32Array, shard: VectorsShard): Map<string, number> {
  const out = new Map<string, number>()
  for (const [path, b64] of Object.entries(shard.vectors)) {
    out.set(path, dot(query, unpackVector(b64, shard.dim)))
  }
  return out
}
