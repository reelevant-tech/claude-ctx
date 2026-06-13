import { VECTOR_SCHEMA_VERSION, type CtxConfig, type VectorsShard } from '../types'
import { currentBranchKey } from '../git'
import { repoId } from '../paths'
import { loadShard } from '../store/shards'
import { loadEmbedder, type Embedder } from './embedder'
import { scoreEntries, type SemanticHit } from './vectors'

function debugWarn(msg: string): void {
  if (process.env.CTX_DEBUG) process.stderr.write(`[claude-ctx semantic] ${msg}\n`)
}

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
  // hard guards: never silently compare across schema / repo / branch.
  if (shard.schemaVersion !== VECTOR_SCHEMA_VERSION) {
    debugWarn(`schema mismatch (shard=${shard.schemaVersion} want=${VECTOR_SCHEMA_VERSION}) — lexical fallback`)
    return undefined
  }
  if (shard.repo && shard.repo.repoId !== repoId(root)) {
    debugWarn(`repoId mismatch (shard=${shard.repo.repoId}) — lexical fallback`)
    return undefined
  }
  const bk = currentBranchKey(root)
  if (shard.gitId && shard.gitId.branchKey !== bk) {
    debugWarn(`branchKey mismatch (shard=${shard.gitId.branchKey} current=${bk}) — lexical fallback`)
    return undefined
  }
  const embedder = embedderOverride ?? (await loadEmbedder(cfg))
  if (!embedder) return undefined
  // P0 guard: never compare vectors built by a different model / dim.
  if (embedder.model !== shard.model) {
    debugWarn(`model mismatch (shard=${shard.model} embedder=${embedder.model}) — lexical fallback`)
    return undefined
  }
  try {
    const [qv] = await embedder.embed([task])
    if (!qv || qv.length !== shard.dim) {
      debugWarn(`dim mismatch (shard=${shard.dim} query=${qv?.length}) — lexical fallback`)
      return undefined
    }
    return scoreEntries(qv, shard)
  } catch {
    return undefined
  }
}
