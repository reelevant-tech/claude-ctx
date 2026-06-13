/**
 * Local, offline embedding backend (transformers.js / WASM — no native deps).
 *
 * Loaded ONLY from cli.cjs and mcp.cjs (the heavy bundles). It must never be
 * imported by the hook hot-path bundle: transformers.js is marked external in
 * esbuild and the hook-bundle guard forbids it. Everything fails open — if the
 * package or model is unavailable, loadEmbedder returns null and callers fall
 * back to pure lexical retrieval.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir } from '../paths'
import type { CtxConfig } from '../types'

export type EmbedRole = 'query' | 'passage'

export interface Embedder {
  model: string
  dim: number
  /** L2-normalized embeddings, one Float32Array per input text. `role` selects
   * the configured prefix (e5/nomic need "query:"/"passage:"); default passage. */
  embed(texts: string[], role?: EmbedRole): Promise<Float32Array[]>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transformers = any

async function importTransformers(): Promise<Transformers | null> {
  // 1) bare specifier — works in dev (project node_modules)
  try {
    return await import('@huggingface/transformers')
  } catch {
    /* try installed location */
  }
  // 2) ~/.claude-ctx/node_modules (populated by `ctx embed-setup`)
  try {
    const req = createRequire(join(dataDir(), 'anchor.cjs'))
    const resolved = req.resolve('@huggingface/transformers')
    return (await import(pathToFileURL(resolved).href)) as Transformers
  } catch {
    return null
  }
}

let cached: { model: string; embedder: Embedder } | null = null
let attempted = false

/**
 * Load (and warm-cache) an embedder for the configured model. Returns null when
 * embeddings are disabled or transformers.js / the model can't be loaded.
 */
export async function loadEmbedder(cfg: CtxConfig): Promise<Embedder | null> {
  if (!cfg.embeddings.enabled) return null
  if (cached && cached.model === cfg.embeddings.model) return cached.embedder
  if (attempted && !cached) return null // don't retry a failed load repeatedly in one process
  attempted = true

  const tf = await importTransformers()
  if (!tf) return null
  try {
    tf.env.cacheDir = join(dataDir(), 'models')
    tf.env.allowRemoteModels = true // download once, then served from cache
    const extractor = await tf.pipeline('feature-extraction', cfg.embeddings.model, { dtype: 'q8' })
    const queryPrefix = cfg.embeddings.queryPrefix ?? ''
    const passagePrefix = cfg.embeddings.passagePrefix ?? ''
    let dim = 0
    const embedder: Embedder = {
      model: cfg.embeddings.model,
      get dim() {
        return dim
      },
      async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<Float32Array[]> {
        if (texts.length === 0) return []
        const prefix = role === 'query' ? queryPrefix : passagePrefix
        const input = prefix ? texts.map((t) => prefix + t) : texts
        const t = await extractor(input, { pooling: 'mean', normalize: true })
        const [n, d] = t.dims as [number, number]
        dim = d
        const data = t.data as Float32Array
        const out: Float32Array[] = []
        for (let i = 0; i < n; i++) out.push(data.slice(i * d, (i + 1) * d))
        return out
      },
    }
    cached = { model: cfg.embeddings.model, embedder }
    return embedder
  } catch {
    return null
  }
}

/** True if transformers.js is resolvable (used by `ctx embed-setup` / doctor). */
export async function transformersAvailable(): Promise<boolean> {
  return (await importTransformers()) !== null
}
