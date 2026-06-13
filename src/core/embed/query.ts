import type { CtxConfig, VectorsShard } from '../types'
import { loadShard } from '../store/shards'
import { loadEmbedder, type Embedder } from './embedder'
import { cosineMap } from './vectors'

/**
 * Semantic cosine scores (path -> similarity) for a task, or undefined when the
 * embeddings layer is unavailable (no vectors shard / no embedder). Callers pass
 * the result to scoreFiles for hybrid ranking; undefined => pure lexical.
 */
export async function semanticScores(
  root: string,
  task: string,
  cfg: CtxConfig,
  embedderOverride?: Embedder | null,
): Promise<Map<string, number> | undefined> {
  const shard = loadShard<VectorsShard>(root, 'vectors')
  if (!shard || Object.keys(shard.vectors).length === 0) return undefined
  const embedder = embedderOverride ?? (await loadEmbedder(cfg))
  if (!embedder) return undefined
  try {
    const [qv] = await embedder.embed([task])
    if (!qv) return undefined
    return cosineMap(qv, shard)
  } catch {
    return undefined
  }
}
