import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VECTOR_SCHEMA_VERSION, type CtxConfig, type FilesShard, type SymbolTreeShard, type VectorEntry, type VectorsShard } from '../types'
import { gitIdentity } from '../git'
import { repoIdentity } from '../paths'
import { loadShard, saveShard } from '../store/shards'
import { fileEmbeddingText, flattenForChunks, symbolChunkText } from './chunk'
import { loadEmbedder, type Embedder } from './embedder'
import { packVector } from './vectors'

const chunkHash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12)

const MAX_SYMBOL_CHUNKS_PER_FILE = 60

// Pure test data / snapshots: high semantic-noise, never a code-retrieval target.
const NOISE_PATH = /(^|\/)(fixtures?|__fixtures__|__snapshots__|testdata|test-data)(\/)|\.snap$/i

/**
 * Files worth embedding: real source/doc/config content. Excludes
 * secrets/assets/vendor, generated code, test files, and fixture/snapshot data.
 * Tests stay in the lexical+structural index (symbol_search/find_tests) but are
 * kept out of the vector space — embedding them crowded real source out of the
 * top results in benchmarks.
 */
export function embeddableFiles(files: FilesShard): string[] {
  const out: string[] = []
  for (const [rel, rec] of Object.entries(files.files)) {
    if (rec.kind === 'secret' || rec.kind === 'asset' || rec.kind === 'vendor' || rec.kind === 'test') continue
    if (rec.risk.includes('generated') || rec.risk.includes('vendor')) continue
    if (NOISE_PATH.test(rel)) continue
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

  const repo = repoIdentity(root)
  const gid = gitIdentity(root)
  const stamp = (m: Omit<VectorEntry, 'vec'>, rec: { h: string }, text: string): Omit<VectorEntry, 'vec'> => {
    m.fileHash = rec.h
    m.chunkHash = chunkHash(text)
    m.repoId = repo.repoId
    m.repoName = repo.repoName
    m.repoRoot = repo.repoRoot
    if (gid.branch) m.branch = gid.branch
    m.branchKey = gid.branchKey
    if (gid.headCommit) m.headCommit = gid.headCommit
    return m
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
    const fileText = fileEmbeddingText(rel, rec.exports, rec.docHeadings, content)
    pending.push({ meta: stamp({ path: rel, startLine: 1, endLine: lines.length || 1 }, rec, fileText), text: fileText })
    // symbol-level chunks (bounded)
    const tree = symtree.trees[rel]
    if (tree && content) {
      for (const { node, parentChain } of flattenForChunks(tree).slice(0, MAX_SYMBOL_CHUNKS_PER_FILE)) {
        if (!node.n) continue
        const text = symbolChunkText(rel, parentChain, node, lines)
        const meta = stamp(
          { path: rel, symbol: node.n, kind: node.k, startLine: node.l, endLine: node.endL },
          rec,
          text,
        )
        pending.push({ meta, text })
      }
    }
  }

  // embed pending chunks in batches
  const fresh: VectorEntry[] = []
  let dim = embedder.dim
  const BATCH = 32
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    const vecs = await embedder.embed(batch.map((p) => p.text), 'passage')
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
    schemaVersion: VECTOR_SCHEMA_VERSION,
    repo,
    gitId: gid,
    model: embedder.model,
    dim: dim || usablePrior?.dim || embedder.dim,
    createdAt: Math.floor(Date.now() / 1000),
    hashes,
    entries,
  }
  if (gid.headCommit) shard.headCommit = gid.headCommit
  saveShard(root, 'vectors', shard)
  return { built: builtFiles, reused: reusedFiles, entries: entries.length, skipped: false, model: embedder.model }
}
