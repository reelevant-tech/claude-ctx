import type { CtxConfig, VectorsShard } from '../types'
import { loadShard } from '../store/shards'
import { loadEmbedder, type Embedder } from './embedder'
import { scoreEntries, type SemanticHit } from './vectors'

/**
 * Semantic hit (per-file cosine + winning symbol) for a task, or undefined when
 * the embeddings layer is unavailable or inconsistent. Guards against a
 * model/dimension mismatch between the stored shard and the current embedder —
 * comparing across models silently produces garbage cosines, so we fall back to
 * pure lexical instead. Callers pass the result to scoreFiles for hybrid ranking.
 */
export async function semanticScores(
  root: string,
  task: string,
  cfg: CtxConfig,
  embedderOverride?: Embedder | null,
): Promise<SemanticHit | undefined> {
  const shard = loadShard<VectorsShard>(root, 'vectors')
  // tolerate a pre-upgrade shard (no entries[]) -> fall back to lexical
  if (!shard || !Array.isArray(shard.entries) || shard.entries.length === 0) return undefined
  const embedder = embedderOverride ?? (await loadEmbedder(cfg))
  if (!embedder) return undefined
  // P0 guard: never compare vectors built by a different model.
  if (embedder.model !== shard.model) return undefined
  try {
    const [qv] = await embedder.embed([task])
    if (!qv || qv.length !== shard.dim) return undefined
    return scoreEntries(qv, shard)
  } catch {
    return undefined
  }
}
