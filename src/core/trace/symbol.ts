import { renderCalls } from '../ast/render'
import { lineSnippet } from '../ast/snippet'
import { pickDefinition } from '../ast/ts-refs'
import { shortestPaths } from '../indexer/graph'
import { relatedFiles } from '../related'
import { loadShard } from '../store/shards'
import { searchSymbols } from '../../cli/commands/symbols'
import { resolveReferences } from '../../cli/commands/references'
import type { CallsShard, LoadedIndex } from '../types'

const ARROW = ' → '

export interface TraceSymbolResult {
  symbol: string
  definition?: { file: string; line: number; kind: string; sig: string; exported: boolean }
  references: ReturnType<typeof resolveReferences>
  callees: { callee: string; line: number }[]
  related: { imports: string[]; importedBy: string[]; tests: string[] }
  importPaths: string[][]
}

export function traceSymbol(
  root: string,
  idx: LoadedIndex,
  symbol: string,
  opts?: { file?: string; depth?: number; pathLimit?: number },
): TraceSymbolResult | null {
  const name = symbol.trim()
  if (!name) return null

  const matches = searchSymbols(idx, name, { limit: 5 }).filter((s) => s.n === name)
  const def =
    pickDefinition(idx.symbols.symbols, name, opts?.file) ??
    (matches[0] ? { f: matches[0].f, l: matches[0].l, k: matches[0].k, sig: matches[0].sig, x: matches[0].x, n: matches[0].n } : null)

  const shard = loadShard<CallsShard>(root, 'calls')
  const references = resolveReferences(root, idx, shard, name, { file: opts?.file })

  const defFile = references.definition?.file ?? def?.f
  const callees: { callee: string; line: number }[] = []
  if (defFile && shard) {
    for (const c of shard.calls[defFile] ?? []) {
      if (c.caller === name) callees.push({ callee: c.callee, line: c.line })
    }
  }

  let related = { imports: [] as string[], importedBy: [] as string[], tests: [] as string[] }
  if (defFile) {
    const g = relatedFiles(idx, defFile)
    related = { imports: g.imports.slice(0, 8), importedBy: g.importedBy.slice(0, 8), tests: g.tests.slice(0, 6) }
  }

  const depth = opts?.depth ?? 2
  const pathLimit = opts?.pathLimit ?? 3
  const importPaths: string[][] = []
  if (defFile && depth > 0) {
    const refFiles = [...new Set(references.refs.map((r) => r.file))].filter((f) => f !== defFile)
    for (const from of refFiles) {
      for (const p of shortestPaths(idx.graph, from, defFile, pathLimit - importPaths.length)) {
        importPaths.push(p)
        if (importPaths.length >= pathLimit) break
      }
      if (importPaths.length >= pathLimit) break
    }
  }

  return {
    symbol: name,
    definition: def
      ? { file: def.f, line: def.l, kind: def.k, sig: def.sig, exported: def.x }
      : references.definition
        ? { ...references.definition, exported: matches.some((m) => m.x && m.f === references.definition!.file) }
        : undefined,
    references,
    callees,
    related,
    importPaths,
  }
}

export function renderTraceSymbol(root: string, trace: TraceSymbolResult): string {
  const lines: string[] = [`## trace: ${trace.symbol}`]
  const def = trace.definition
  if (def) {
    const vis = def.exported ? '' : ' (private)'
    lines.push(`**Definition:** ${def.file}:${def.line}  ${def.kind}${vis}  ${def.sig}`)
    const snip = lineSnippet(root, def.file, def.line)
    if (snip) lines.push(`  ${snip}`)
  } else {
    lines.push('**Definition:** not found in index')
  }

  // Role tagging is grounded in the AST `calls` shard: a reference whose file:line
  // is a known call expression for this symbol is a CALL; the definition site is DEF;
  // everything else is a USE (value/type/import). The finer TYPE-USE vs IMPORT split
  // needs the deferred typed cross-file data-flow work — see plan "data-flow tracer".
  const shard = loadShard<CallsShard>(root, 'calls')
  const callLines = new Set<string>()
  if (shard) {
    for (const file of Object.keys(shard.calls)) {
      for (const c of shard.calls[file]!) {
        if (c.callee === trace.symbol) callLines.add(`${file}:${c.line}`)
      }
    }
  }

  const { refs, source } = trace.references
  const srcNote =
    source === 'typescript'
      ? 'typed, complete within indexed TS files'
      : 'name-based (call-sites only; may miss type/import uses & over-match common names)'
  if (refs.length === 0) {
    lines.push(`**References:** none — ${srcNote}`)
  } else {
    const rfiles = new Set(refs.map((r) => r.file)).size
    lines.push(
      `**References** — ${srcNote} · ${refs.length} ref${refs.length === 1 ? '' : 's'} across ${rfiles} file${rfiles === 1 ? '' : 's'} (roles: def/call/use):`,
    )
    for (const r of refs) {
      const role =
        def && r.file === def.file && r.line === def.line
          ? 'def'
          : callLines.has(`${r.file}:${r.line}`)
            ? 'call'
            : 'use'
      let row = `  [${role}] ${r.file}:${r.line}`
      if (r.caller) row += `  in ${r.caller}()`
      lines.push(row)
      if (r.snippet) lines.push(`    ${r.snippet}`)
    }
  }

  if (trace.callees.length > 0) {
    lines.push(`**Callees** (from ${trace.symbol}):`)
    for (const c of trace.callees) lines.push(`  → ${c.callee}() [L${c.line}]`)
  } else if (def) {
    const all = shard?.calls[def.file] ?? []
    if (all.length > 0) {
      lines.push(`**Calls in ${def.file}** (file-level):`)
      lines.push(renderCalls(all).split('\n').map((l) => `  ${l}`).join('\n'))
    }
  }

  const { imports, importedBy, tests } = trace.related
  if (imports.length > 0 || importedBy.length > 0 || tests.length > 0) {
    lines.push('**Related files:**')
    if (imports.length > 0) lines.push(`  imports: ${imports.join(', ')}`)
    if (importedBy.length > 0) lines.push(`  imported by: ${importedBy.join(', ')}`)
    if (tests.length > 0) lines.push(`  tests: ${tests.join(', ')}`)
  }

  if (trace.importPaths.length > 0) {
    lines.push('**Import paths** (caller → definition):')
    for (const p of trace.importPaths) lines.push(`  ${p.join(ARROW)}`)
  }

  lines.push(`_Expand: mcp__ctx__references('${trace.symbol}'), mcp__ctx__related_files('${def?.file ?? ''}')_`)
  return lines.join('\n')
}
