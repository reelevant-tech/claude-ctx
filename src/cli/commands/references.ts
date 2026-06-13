import { lineSnippet } from '../../core/ast/snippet'
import { findTsReferences, pickDefinition } from '../../core/ast/ts-refs'
import { loadShard, shardMtimeMs } from '../../core/store/shards'
import type { CallsShard, LoadedIndex } from '../../core/types'
import { out, parseCommon, requireIndex } from '../shared'

export interface Reference {
  file: string
  line: number
  caller?: string
  snippet?: string
}

export type ReferencesSource = 'typescript' | 'name-based'

/** Name-based call sites of a symbol across all files (ignores shadowing/overloads). */
export function findReferencesByName(shard: CallsShard, symbol: string): Reference[] {
  const refs: Reference[] = []
  for (const file of Object.keys(shard.calls).sort()) {
    for (const c of shard.calls[file]!) {
      if (c.callee === symbol) refs.push(c.caller ? { file, line: c.line, caller: c.caller } : { file, line: c.line })
    }
  }
  return refs
}

function attachCallers(refs: Reference[], shard: CallsShard | null): Reference[] {
  if (!shard) return refs
  return refs.map((r) => {
    if (r.caller) return r
    const call = shard.calls[r.file]?.find((c) => c.line === r.line)
    return call?.caller ? { ...r, caller: call.caller } : r
  })
}

function attachSnippets(root: string, refs: Reference[]): Reference[] {
  return refs.map((r) => {
    const snippet = lineSnippet(root, r.file, r.line)
    return snippet ? { ...r, snippet } : r
  })
}

/** Resolve references: TS language service when possible, else name-based call index. */
export function resolveReferences(
  root: string,
  idx: LoadedIndex | null,
  shard: CallsShard | null,
  symbol: string,
  opts?: { file?: string; snippets?: boolean },
): { refs: Reference[]; source: ReferencesSource; definition?: { file: string; line: number; kind: string; sig: string } } {
  const fileHint = opts?.file
  const def = idx ? pickDefinition(idx.symbols.symbols, symbol, fileHint) : null
  const definition = def ? { file: def.f, line: def.l, kind: def.k, sig: def.sig } : undefined

  if (idx) {
    const cacheKey = shardMtimeMs(root, 'meta') ?? idx.meta.indexedAt
    const tsRefs = findTsReferences(root, idx, symbol, cacheKey, fileHint)
    if (tsRefs !== null) {
      let refs = attachCallers(
        tsRefs.map((r) => ({ file: r.file, line: r.line })),
        shard,
      )
      if (opts?.snippets !== false) refs = attachSnippets(root, refs)
      return { refs, source: 'typescript', definition }
    }
  }

  if (!shard) return { refs: [], source: 'name-based', definition }
  let refs = findReferencesByName(shard, symbol)
  if (opts?.snippets !== false) refs = attachSnippets(root, refs)
  return { refs, source: 'name-based', definition }
}

export function renderReferences(
  symbol: string,
  result: ReturnType<typeof resolveReferences>,
): string {
  const { refs, source, definition } = result
  if (refs.length === 0) {
    const hint =
      source === 'typescript'
        ? `No references found for "${symbol}" (TypeScript).`
        : `No call sites found for "${symbol}" (name-based).`
    return hint
  }
  const files = new Set(refs.map((r) => r.file)).size
  const span = `${refs.length} ref${refs.length === 1 ? '' : 's'} across ${files} file${files === 1 ? '' : 's'}`
  const label =
    source === 'typescript'
      ? `References to "${symbol}" — typed, complete within indexed TS files · ${span}:`
      : `Call sites of "${symbol}" — name-based (call-sites only; may miss type/import uses & over-match common names) · ${span}:`
  const lines: string[] = [label]
  if (definition) lines.push(`  definition: ${definition.file}:${definition.line}  ${definition.kind}  ${definition.sig}`)
  for (const r of refs) {
    let line = `  ${r.file}:${r.line}`
    if (r.caller) line += `  in ${r.caller}()`
    if (r.snippet) line += `\n    ${r.snippet}`
    lines.push(line)
  }
  return lines.join('\n')
}

// Back-compat alias used by tests
export function findReferences(shard: CallsShard, symbol: string): Reference[] {
  return findReferencesByName(shard, symbol)
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { file: { type: 'string' } })
  const symbol = a.positionals[0]
  if (!symbol) {
    process.stderr.write('Usage: ctx references <symbol> [--file <path>]\n')
    return 1
  }
  const idx = requireIndex(a.repo)
  const shard = loadShard<CallsShard>(a.repo, 'calls')
  if (!idx && !shard) {
    process.stderr.write('No index. Run: ctx index\n')
    process.exitCode = 1
    return 1
  }
  const file = typeof a.values.file === 'string' ? a.values.file : undefined
  const result = resolveReferences(a.repo, idx, shard, symbol, { file })
  if (a.json) {
    out(JSON.stringify(result, null, 2))
    return 0
  }
  out(renderReferences(symbol, result))
  return 0
}
