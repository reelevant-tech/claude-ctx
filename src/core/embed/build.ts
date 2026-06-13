import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CtxConfig, FilesShard, SymbolTreeShard, VectorEntry, VectorsShard } from '../types'
import { headCommit } from '../indexer/gitsig'
import { loadShard, saveShard } from '../store/shards'
import { fileEmbeddingText, flattenForChunks, symbolChunkText } from './chunk'
import { loadEmbedder, type Embedder } from './embedder'
import { packVector } from './vectors'

const MAX_SYMBOL_CHUNKS_PER_FILE = 60

/** Files worth embedding: real source/test/config/doc content. Excludes
 * secrets/assets/vendor AND generated code (noise). */
function embeddableFiles(files: FilesShard): string[] {
  const out: string[] = []
  for (const [rel, rec] of Object.entries(files.files)) {
    if (rec.kind === 'secret' || rec.kind === 'asset' || rec.kind === 'vendor') continue
    if (rec.risk.includes('generated') || rec.risk.includes('vendor')) continue
    if (rec.parser === 'none' && rec.kind !== 'doc' && rec.kind !== 'config') continue
    out.push(rel)
  }
  return out.sort()
}

export interface VectorBuildResult {
  /** files (re)embedded this run */
  built: number
  /** files whose vectors were reused unchanged */
  reused: number
  /** total chunks (entries) in the shard */
  entries: number
  skipped: boolean // true when no embedder available (fail-open to lexical)
  model?: string
}

interface PendingChunk {
  meta: Omit<VectorEntry, 'vec'>
  text: string
}

/**
 * Build (or refresh) the vectors shard with symbol-level + file-level chunks.
 * Incremental by content hash: a file is re-embedded only when its hash changed
 * (or the model changed). Async + slow; runs only in the heavy bundles. Fails
 * open: no embedder => leaves any existing shard untouched, reports skipped.
 */
export async function buildVectors(
  root: string,
  cfg: CtxConfig,
  opts?: { embedder?: Embedder | null },
): Promise<VectorBuildResult> {
  const embedder = opts?.embedder ?? (await loadEmbedder(cfg))
  if (!embedder) return { built: 0, reused: 0, entries: 0, skipped: true }

  const files = loadShard<FilesShard>(root, 'files')
  if (!files) return { built: 0, reused: 0, entries: 0, skipped: true }
  const symtree = loadShard<SymbolTreeShard>(root, 'symtree') ?? { trees: {}, parsers: {} }

  const prior = loadShard<VectorsShard>(root, 'vectors')
  // a pre-upgrade shard lacks entries[]/hashes -> treat as no prior (full rebuild)
  const usablePrior = prior && Array.isArray(prior.entries) && prior.hashes ? prior : null
  const modelMatch = usablePrior?.model === embedder.model
  const priorByPath = new Map<string, VectorEntry[]>()
  if (modelMatch && usablePrior) {
    for (const e of usablePrior.entries) {
      const arr = priorByPath.get(e.path) ?? []
      arr.push(e)
      priorByPath.set(e.path, arr)
    }
  }

  const targets = embeddableFiles(files)
  const hashes: Record<string, string> = {}
  const reused: VectorEntry[] = []
  const pending: PendingChunk[] = []
  let reusedFiles = 0
  let builtFiles = 0

  for (const rel of targets) {
    const rec = files.files[rel]!
    hashes[rel] = rec.h
    // reuse unchanged files (same content hash, same model)
    if (modelMatch && usablePrior?.hashes[rel] === rec.h && priorByPath.has(rel)) {
      reused.push(...priorByPath.get(rel)!)
      reusedFiles++
      continue
    }
    builtFiles++
    let content: string | null = null
    try {
      content = readFileSync(join(root, rel), 'utf8')
    } catch {
      content = null
    }
    const lines = content ? content.split('\n') : []
    // file-level chunk
    pending.push({
      meta: { path: rel, startLine: 1, endLine: lines.length || 1 },
      text: fileEmbeddingText(rel, rec.exports, rec.docHeadings, content),
    })
    // symbol-level chunks (bounded)
    const tree = symtree.trees[rel]
    if (tree && content) {
      for (const { node, parentChain } of flattenForChunks(tree).slice(0, MAX_SYMBOL_CHUNKS_PER_FILE)) {
        if (!node.n) continue
        const meta: Omit<VectorEntry, 'vec'> = {
          path: rel,
          symbol: node.n,
          kind: node.k,
          startLine: node.l,
          endLine: node.endL,
        }
        pending.push({ meta, text: symbolChunkText(rel, parentChain, node, lines) })
      }
    }
  }

  // embed pending chunks in batches
  const fresh: VectorEntry[] = []
  let dim = embedder.dim
  const BATCH = 32
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    const vecs = await embedder.embed(batch.map((p) => p.text))
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j]
      if (!v) continue
      dim = v.length
      fresh.push({ ...batch[j]!.meta, vec: packVector(v) })
    }
  }

  const entries = [...reused, ...fresh].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine),
  )
  const shard: VectorsShard = {
    model: embedder.model,
    dim: dim || usablePrior?.dim || embedder.dim,
    createdAt: Math.floor(Date.now() / 1000),
    hashes,
    entries,
  }
  const hc = headCommit(root)
  if (hc) shard.headCommit = hc
  saveShard(root, 'vectors', shard)
  return { built: builtFiles, reused: reusedFiles, entries: entries.length, skipped: false, model: embedder.model }
}
