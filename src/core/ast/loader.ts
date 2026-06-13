/**
 * Lazy tree-sitter loader (web-tree-sitter / WASM — no native deps). Used only
 * by the heavy bundles (cli.cjs, mcp.cjs) via the indexer; never the hook
 * hot-path (the esbuild guard forbids `ast/` and `web-tree-sitter` in hook.cjs).
 * Fails open: any failure to locate/init the runtime or a grammar returns null,
 * and the caller falls back to the regex Rust parser.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
// web-tree-sitter 0.20.x ships loose types; treat the module as untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import Parser from 'web-tree-sitter'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParser = any

export type TSLang = 'rust' | 'typescript' | 'tsx' | 'javascript'

const WASM: Record<TSLang, string> = {
  rust: 'tree-sitter-rust.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
}

/** Locate a wasm file: shipped grammars/ dir next to the bundle, else dev node_modules. */
function resolveWasm(name: string): string | null {
  const beside = join(dirname(process.argv[1] ?? ''), 'grammars', name)
  if (existsSync(beside)) return beside
  const devCandidates =
    name === 'tree-sitter.wasm'
      ? [join(process.cwd(), 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')]
      : [join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', name)]
  for (const c of devCandidates) if (existsSync(c)) return c
  return null
}

let initPromise: Promise<boolean> | null = null
const parserCache = new Map<TSLang, AnyParser>()

function ensureInit(): Promise<boolean> {
  if (!initPromise) {
    initPromise = (async () => {
      const runtime = resolveWasm('tree-sitter.wasm')
      if (!runtime) return false
      try {
        await Parser.init({ locateFile: (n: string) => resolveWasm(n) ?? n })
        return true
      } catch {
        return false
      }
    })()
  }
  return initPromise
}

/** A parser bound to the given language, or null if unavailable. Cached per language. */
export async function getParser(lang: TSLang): Promise<AnyParser | null> {
  if (!(await ensureInit())) return null
  const cached = parserCache.get(lang)
  if (cached) return cached
  const wp = resolveWasm(WASM[lang])
  if (!wp) return null
  try {
    const Language = await Parser.Language.load(wp)
    const parser = new Parser()
    parser.setLanguage(Language)
    parserCache.set(lang, parser)
    return parser
  } catch {
    return null
  }
}

/** True if the runtime + Rust grammar are loadable (used by doctor/setup checks). */
export async function treeSitterAvailable(): Promise<boolean> {
  return (await getParser('rust')) !== null
}
