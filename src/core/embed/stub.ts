import type { Embedder } from './embedder'

/**
 * Deterministic, dependency-free embedder for tests: a normalized hashed
 * bag-of-tokens, so cosine ≈ token overlap. Lets the hybrid path be tested
 * without downloading a real model.
 */
export function createStubEmbedder(dim = 64): Embedder {
  return {
    model: 'stub',
    dim,
    async embed(texts: string[], _role?: 'query' | 'passage'): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = new Float32Array(dim)
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/)) {
          if (!tok) continue
          let h = 2166136261
          for (let i = 0; i < tok.length; i++) {
            h ^= tok.charCodeAt(i)
            h = Math.imul(h, 16777619)
          }
          v[(h >>> 0) % dim] = (v[(h >>> 0) % dim] ?? 0) + 1
        }
        let norm = 0
        for (let i = 0; i < dim; i++) norm += (v[i] ?? 0) * (v[i] ?? 0)
        norm = Math.sqrt(norm) || 1
        for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm
        return v
      })
    },
  }
}
