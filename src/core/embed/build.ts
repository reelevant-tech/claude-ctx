import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CtxConfig, FilesShard, VectorsShard } from '../types'
import { loadShard, saveShard } from '../store/shards'
import { fileEmbeddingText } from './chunk'
import { loadEmbedder, type Embedder } from './embedder'

/** Files worth embedding: real source/doc/config content (never secrets/assets). */
function embeddableFiles(files: FilesShard): string[] {
  const out: string[] = []
  for (const [rel, rec] of Object.entries(files.files)) {
    if (rec.kind === 'secret' || rec.kind === 'asset' || rec.kind === 'vendor') continue
    if (rec.parser === 'none' && rec.kind !== 'doc' && rec.kind !== 'config') continue
    out.push(rel)
  }
  return out.sort()
}

export interface VectorBuildResult {
  built: number
  skipped: boolean // true when no embedder available (fail-open to lexical)
  model?: string
}

/**
 * Build (or refresh) the vectors shard. Async + slow; runs only in the heavy
 * bundles. Fails open: if no embedder is available, leaves any existing shard
 * untouched and reports skipped=true. `changedOnly` re-embeds just those files,
 * reusing prior vectors for the rest.
 */
export async function buildVectors(
  root: string,
  cfg: CtxConfig,
  opts?: { embedder?: Embedder | null; changedOnly?: string[] },
): Promise<VectorBuildResult> {
  const embedder = opts?.embedder ?? (await loadEmbedder(cfg))
  if (!embedder) return { built: 0, skipped: true }

  const files = loadShard<FilesShard>(root, 'files')
  if (!files) return { built: 0, skipped: true }

  const prior = loadShard<VectorsShard>(root, 'vectors')
  const reusable =
    prior && prior.model === embedder.model && opts?.changedOnly ? prior.vectors : {}

  const all = embeddableFiles(files)
  const targets = opts?.changedOnly
    ? all.filter((f) => opts.changedOnly!.includes(f) || reusable[f] === undefined)
    : all

  const { packVector } = await import('./vectors')
  const vectors: Record<string, string> = { ...reusable }
  // drop vectors for files no longer present
  for (const k of Object.keys(vectors)) if (!files.files[k]) delete vectors[k]

  const BATCH = 32
  let dim = 0
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH)
    const texts = batch.map((rel) => {
      const rec = files.files[rel]!
      let content: string | null = null
      try {
        content = readFileSync(join(root, rel), 'utf8')
      } catch {
        content = null
      }
      return fileEmbeddingText(rel, rec.exports, rec.docHeadings, content)
    })
    const vecs = await embedder.embed(texts)
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j]
      if (!v) continue
      dim = v.length
      vectors[batch[j]!] = packVector(v)
    }
  }

  const shard: VectorsShard = { model: embedder.model, dim: dim || embedder.dim, vectors }
  saveShard(root, 'vectors', shard)
  return { built: targets.length, skipped: false, model: embedder.model }
}
