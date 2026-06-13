import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig } from '../core/config'
import { renderCalls, renderSymbolTree } from '../core/ast/render'
import { buildVectors } from '../core/embed/build'
import { semanticScores } from '../core/embed/query'
import { buildIndex } from '../core/indexer/index'
import { shortestPaths } from '../core/indexer/graph'
import { classifyRisk } from '../core/indexer/risk'
import { buildTreeSummary } from '../core/indexer/tree'
import { redactSecrets } from '../core/guard/redact'
import { appendEvent, latestSessionId } from '../core/memory/log'
import { loadState } from '../core/memory/state'
import { summaryPath } from '../core/paths'
import { buildPack } from '../core/router/pack'
import { renderOverview, renderPack } from '../core/router/render'
import { loadIndex, loadShard, shardMtimeMs } from '../core/store/shards'
import { estimateTokens } from '../core/tokens'
import { clearTsRefsCache } from '../core/ast/ts-refs'
import { callSiteSet, renderReferences, resolveReferences } from '../cli/commands/references'
import { renderTraceSymbol, traceSymbol } from '../core/trace/symbol'
import { renderSymbolBody, symbolBody } from '../core/trace/body'
import { callChain, renderCallChain } from '../core/trace/call-chain'
import { relatedFiles } from '../cli/commands/related'
import { bestTestCommand } from '../cli/commands/tests-cmd'
import { searchSymbols } from '../cli/commands/symbols'
import type { CallsShard, LoadedIndex, RepoSummary, SymbolTreeShard } from '../core/types'

export interface ToolContext {
  root: string
}

const ARROW = ' → '
const NO_INDEX = 'No index for this repo yet — run mcp__ctx__index_refresh or `ctx index`.'

// in-memory index cache, invalidated on meta.json mtime change
let cache: { root: string; mtime: number | null; idx: LoadedIndex | null } | null = null
function getIndex(root: string): LoadedIndex | null {
  const mtime = shardMtimeMs(root, 'meta')
  if (cache && cache.root === root && cache.mtime === mtime) return cache.idx
  const idx = mtime === null ? null : loadIndex(root)
  cache = { root, mtime, idx }
  return idx
}

function loadSummary(root: string): RepoSummary | null {
  try {
    return JSON.parse(readFileSync(summaryPath(root), 'utf8')) as RepoSummary
  } catch {
    return null
  }
}

function cap(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  return text.slice(0, maxTokens * 4) + '\n…[truncated — refine query]'
}

let rgChecked = false
let rgAvailable = false
function hasRipgrep(): boolean {
  if (rgChecked) return rgAvailable
  rgChecked = true
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore', timeout: 5000 })
    rgAvailable = true
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}

type ToolImpl = (root: string, args: Record<string, unknown>) => string | Promise<string>

/** Pure tool logic. Each returns rendered text; never throws (returns guidance instead). */
export const toolImpls: Record<string, ToolImpl> = {
  repo_overview(root) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const m = idx.meta
    const freshness = `Index: ${m.fileCount} files, indexed ${new Date(m.indexedAt * 1000).toISOString()}${m.partial ? ' (building...)' : ''}`
    return `${renderOverview(idx, loadSummary(root), 1200)}\n\n${freshness}`
  },

  repo_tree(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const dir = typeof args.dir === 'string' ? args.dir.replace(/\/+$/, '') : ''
    const max = typeof args.max_entries === 'number' ? args.max_entries : 60
    let files = Object.keys(idx.files.files)
    if (dir) files = files.filter((f) => f.startsWith(dir + '/')).map((f) => f.slice(dir.length + 1))
    return buildTreeSummary(files.map((rel) => ({ rel })), max) || '(empty)'
  },

  async context_pack(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const task = String(args.task ?? '').trim()
    if (!task) return 'Provide a task description.'
    const budget = typeof args.max_tokens === 'number' ? args.max_tokens : 2000
    const cfg = loadConfig(root)
    const sid = latestSessionId(root) ?? 'mcp'
    const state = loadState(root, sid)
    const sem = await semanticScores(root, task, cfg)
    const pack = buildPack(task, idx, state, {
      budget,
      withExcerpts: true,
      root,
      redact: redactSecrets,
      semantic: sem?.scores,
      semanticSymbols: sem?.symbols,
      semWeight: cfg.embeddings.weight,
      aliases: cfg.tokenAliases,
    })
    return renderPack(pack)
  },

  symbol_search(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const query = String(args.query ?? '').trim()
    if (!query) return 'Provide a query.'
    const limit = typeof args.limit === 'number' ? args.limit : 20
    // gather more than we show so we can report total + breadth (coverage)
    const all = searchSymbols(idx, query, {
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      exportedOnly: args.exported_only === true,
      limit: 1000,
    })
    if (all.length > 0) {
      const files = new Set(all.map((s) => s.f)).size
      const shown = all.slice(0, limit)
      const header = `${all.length} symbol${all.length === 1 ? '' : 's'} match "${query}" across ${files} file${files === 1 ? '' : 's'}${all.length > shown.length ? ` (showing ${shown.length})` : ''}:`
      return [header, ...shown.map((s) => `${s.n}  ${s.k}  ${s.f}:${s.l}  — ${s.sig}`)].join('\n')
    }
    // fallback: ripgrep content search
    if (hasRipgrep()) {
      try {
        const out = execFileSync('rg', ['-l', '--max-count', '5', '-F', query, '-g', '!.git', '.'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        const files = out.split('\n').filter(Boolean).slice(0, 10)
        if (files.length > 0) return `No symbol match. Content matches:\n${files.map((f) => `  ${f}`).join('\n')}`
      } catch {
        /* no matches */
      }
    }
    return `No symbols or content matching "${query}".`
  },

  related_files(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const path = String(args.path ?? '')
    if (!idx.files.files[path]) return `Not in index: ${path}`
    const g = relatedFiles(idx, path)
    const lines: string[] = [`Related to ${path}:`]
    const sec = (label: string, items: string[]) => {
      if (items.length > 0) lines.push(`  ${label}: ${items.join(', ')}`)
    }
    sec('Imports', g.imports)
    sec('Imported by', g.importedBy)
    sec('Co-changed', g.coChanged)
    sec('Tests', g.tests)
    sec('Same directory', g.sameDir)
    sec('Naming siblings', g.namingSiblings)
    return lines.length > 1 ? lines.join('\n') : `No related files for ${path}.`
  },

  dep_trace(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const from = String(args.from ?? '')
    if (!idx.files.files[from]) return `Not in index: ${from}`
    const to = typeof args.to === 'string' ? args.to : undefined
    if (to) {
      const paths = shortestPaths(idx.graph, from, to, 3)
      if (paths.length === 0) return `No dependency path from ${from} to ${to}.`
      return paths.map((p) => p.join(ARROW)).join('\n')
    }
    const fanout = idx.graph.fwd[from] ?? []
    const fanin = idx.graph.rev[from] ?? []
    return [
      `${from} (centrality ${idx.graph.centrality[from] ?? 0}):`,
      fanout.length > 0 ? `  imports: ${fanout.join(', ')}` : '  imports: none',
      fanin.length > 0 ? `  imported by: ${fanin.join(', ')}` : '  imported by: none',
    ].join('\n')
  },

  find_tests(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const path = String(args.path ?? '')
    const rec = idx.files.files[path]
    if (!rec) return `Not in index: ${path}`
    const selfTest = rec.tests.includes(path)
    const tests = rec.tests.filter((t) => t !== path)
    const lines: string[] = []
    lines.push(tests.length > 0 ? `Tests for ${path}: ${tests.join(', ')}` : `No mapped test files for ${path}.`)
    if (selfTest) lines.push('  (contains inline #[cfg(test)] tests)')
    const cmd = bestTestCommand(idx, path)
    if (cmd) lines.push(`Run: ${cmd}`)
    return lines.join('\n')
  },

  symbol_tree(root, args) {
    const shard = loadShard<SymbolTreeShard>(root, 'symtree')
    if (!shard) return NO_INDEX
    const path = String(args.path ?? '')
    const tree = shard.trees[path]
    if (!tree || tree.length === 0) return `No symbol tree for ${path} (parser: ${shard.parsers[path] ?? 'none'}).`
    return `${path} (${shard.parsers[path] ?? 'none'}):\n${renderSymbolTree(tree)}`
  },

  calls(root, args) {
    const shard = loadShard<CallsShard>(root, 'calls')
    if (!shard) return NO_INDEX
    const path = String(args.path ?? '')
    return `Calls in ${path} (intra-file, best-effort):\n${renderCalls(shard.calls[path] ?? [])}`
  },

  references(root, args) {
    const idx = getIndex(root)
    const shard = loadShard<CallsShard>(root, 'calls')
    if (!idx && !shard) return NO_INDEX
    const symbol = String(args.symbol ?? '').trim()
    if (!symbol) return 'Provide a symbol name.'
    const file = typeof args.file === 'string' ? args.file : undefined
    const result = resolveReferences(root, idx, shard, symbol, { file })
    if (args.kind === 'calls') {
      const cs = callSiteSet(shard, symbol)
      result.refs = result.refs.filter((r) => cs.has(`${r.file}:${r.line}`))
    }
    return renderReferences(symbol, result)
  },

  trace_symbol(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const symbol = String(args.symbol ?? '').trim()
    if (!symbol) return 'Provide a symbol name.'
    const file = typeof args.file === 'string' ? args.file : undefined
    const depth = typeof args.depth === 'number' ? args.depth : undefined
    const kind = args.kind === 'calls' ? 'calls' : 'all'
    const trace = traceSymbol(root, idx, symbol, { file, depth })
    if (!trace) return `Could not trace "${symbol}".`
    return renderTraceSymbol(root, trace, { kind })
  },

  symbol_body(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const symbol = String(args.symbol ?? '').trim()
    if (!symbol) return 'Provide a symbol name.'
    const file = typeof args.file === 'string' ? args.file : undefined
    const maxLines = typeof args.max_lines === 'number' ? args.max_lines : undefined
    const body = symbolBody(root, idx, symbol, { file, maxLines })
    if (!body) return `Could not locate the body of "${symbol}".`
    return renderSymbolBody(body)
  },

  call_chain(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const symbol = String(args.symbol ?? '').trim()
    if (!symbol) return 'Provide a symbol name.'
    const depth = typeof args.depth === 'number' ? args.depth : undefined
    const chain = callChain(root, idx, symbol, { depth })
    if (!chain) return `Could not build a call chain for "${symbol}".`
    return renderCallChain(chain)
  },

  recent_changes(root, args) {
    const idx = getIndex(root)
    if (!idx) return NO_INDEX
    const days = typeof args.days === 'number' ? args.days : 7
    const limit = typeof args.limit === 'number' ? args.limit : 20
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400
    const recent = idx.git.recent.filter((r) => r.ts >= cutoff).slice(0, limit)
    if (recent.length === 0) return `No changes in the last ${days} days (or not a git repo).`
    return recent
      .map((r) => {
        const co = idx.git.cochange[r.f]
        const coStr = co && co.length > 0 ? `  (co-changes: ${co.slice(0, 3).map(([f]) => f).join(', ')})` : ''
        return `${r.f} — ${r.subject}${coStr}`
      })
      .join('\n')
  },

  risk_check(root, args) {
    const idx = getIndex(root)
    const path = String(args.path ?? '')
    const cfg = loadConfig(root)
    const { kind, risk } = classifyRisk(path, cfg)
    const rec = idx?.files.files[path]
    const all = new Set<string>([...risk, ...(rec?.risk ?? [])])
    if (all.size === 0) return `${path}: ok (${kind ?? rec?.kind ?? 'source'}) — no risk flags.`
    const guide: Record<string, string> = {
      secret: 'never read or index its contents',
      generated: 'edit the source generator, not this file',
      vendor: 'third-party code; do not edit in place',
      infra: 'production-sensitive; confirm with the user before changing',
      huge: 'use symbol_search to find the relevant section',
    }
    const lines = [`${path}: ${[...all].join(', ')}`]
    for (const r of all) if (guide[r]) lines.push(`  - ${guide[r]}`)
    return lines.join('\n')
  },

  session_summary(root) {
    const s = loadSummary(root)
    if (!s || s.sessions.length === 0) return 'No session history.'
    const lines: string[] = []
    for (const e of s.sessions) {
      lines.push(`• ${e.task}`)
      if (e.filesEdited.length > 0) lines.push(`  edited: ${e.filesEdited.join(', ')}`)
      for (const n of e.notes) lines.push(`  note: ${n}`)
    }
    return lines.join('\n')
  },

  session_note(root, args) {
    const text = String(args.text ?? '').trim()
    if (!text) return 'Provide note text.'
    const kind = args.kind as 'decision' | 'todo' | 'question' | undefined
    const sid = latestSessionId(root) ?? 'mcp'
    try {
      appendEvent(root, sid, { ts: Math.floor(Date.now() / 1000), e: 'note', text: text.slice(0, 200), kind })
      return 'noted'
    } catch {
      return 'could not record note'
    }
  },

  async index_refresh(root, args) {
    const full = args.full === true
    const stats = await buildIndex(root, { mode: full ? 'full' : undefined })
    cache = null // invalidate
    clearTsRefsCache()
    const cfg = loadConfig(root)
    let embed = ''
    if (cfg.embeddings.enabled) {
      const r = await buildVectors(root, cfg)
      embed = r.skipped ? ' (embeddings: unavailable)' : `, ${r.built} embedded`
    }
    return `Reindexed: ${stats.fileCount} files, ${stats.symbolCount} symbols, ${stats.durationMs}ms (${stats.mode})${embed}`
  },
}

/** Build the MCP server with all 18 tools registered as thin wrappers over toolImpls. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'ctx', version: '0.1.0' })
  const cfg = loadConfig(ctx.root)
  const wrap = (name: string) => async (args: Record<string, unknown>) => {
    let text: string
    try {
      text = await toolImpls[name]!(ctx.root, args)
    } catch {
      text = NO_INDEX
    }
    return { content: [{ type: 'text' as const, text: cap(text, cfg.mcpMaxResultTokens) }] }
  }

  server.registerTool('repo_overview', { description: 'Project type, packages, entrypoints, commands, tree, and index freshness.', inputSchema: {} }, wrap('repo_overview'))
  server.registerTool('repo_tree', { description: 'Compact repo tree, optionally scoped to a directory.', inputSchema: { dir: z.string().optional(), depth: z.number().optional(), max_entries: z.number().optional() } }, wrap('repo_tree'))
  server.registerTool('context_pack', { description: 'Files for a task/feature (not one symbol): ranked files, why, symbols, tests, deps. Use FIRST for multi-file work; for a single symbol use trace_symbol.', inputSchema: { task: z.string(), max_tokens: z.number().optional() } }, wrap('context_pack'))
  server.registerTool('symbol_search', { description: 'Find a symbol by name when you do not know its file (prefer over grep). Then trace_symbol for the full picture.', inputSchema: { query: z.string(), kind: z.string().optional(), exported_only: z.boolean().optional(), limit: z.number().optional() } }, wrap('symbol_search'))
  server.registerTool('related_files', { description: 'Files related to a path: imports, importers, co-changed, tests, siblings.', inputSchema: { path: z.string() } }, wrap('related_files'))
  server.registerTool('dep_trace', { description: 'Dependency path between two files, or fan-in/fan-out for one file.', inputSchema: { from: z.string(), to: z.string().optional() } }, wrap('dep_trace'))
  server.registerTool('symbol_tree', { description: 'Nested symbol tree of a file (module/class/impl > methods) from the AST.', inputSchema: { path: z.string() } }, wrap('symbol_tree'))
  server.registerTool('calls', { description: 'Intra-file call expressions in a file, grouped by caller (best-effort).', inputSchema: { path: z.string() } }, wrap('calls'))
  server.registerTool('references', { description: 'Every usage site of a symbol (TypeScript-typed when possible, else name-based call-sites). kind:"calls" keeps only call-sites (drops imports/type-uses). Use trace_symbol if you also want the definition + neighborhood.', inputSchema: { symbol: z.string(), file: z.string().optional(), kind: z.enum(['all', 'calls']).optional() } }, wrap('references'))
  server.registerTool('trace_symbol', { description: 'Start here for ONE symbol: definition + references (tagged def/call/use) + callees + import paths + related files in one call. kind:"calls" filters to call-sites only. Use instead of chaining symbol_search → references.', inputSchema: { symbol: z.string(), file: z.string().optional(), depth: z.number().optional(), kind: z.enum(['all', 'calls']).optional() } }, wrap('trace_symbol'))
  server.registerTool('symbol_body', { description: 'Full source body of a symbol in one call (definition → end-of-body, redacted). Use this instead of repeated Reads when you need to see a whole function/class.', inputSchema: { symbol: z.string(), file: z.string().optional(), max_lines: z.number().optional() } }, wrap('symbol_body'))
  server.registerTool('call_chain', { description: 'Best-effort cross-file execution flow from a symbol (callee → target file, edges labelled import/heuristic/same-file). Use to see SDK→…→engine chains; exact usage via references/trace_symbol.', inputSchema: { symbol: z.string(), depth: z.number().optional() } }, wrap('call_chain'))
  server.registerTool('find_tests', { description: 'Tests covering a file and the command to run them.', inputSchema: { path: z.string() } }, wrap('find_tests'))
  server.registerTool('recent_changes', { description: 'Recently changed files and co-change clusters.', inputSchema: { days: z.number().optional(), limit: z.number().optional() } }, wrap('recent_changes'))
  server.registerTool('risk_check', { description: 'Risk classification for a path (generated/vendor/infra/secret).', inputSchema: { path: z.string() } }, wrap('risk_check'))
  server.registerTool('session_summary', { description: 'Recent session memory: prior tasks, edited files, notes.', inputSchema: {} }, wrap('session_summary'))
  server.registerTool('session_note', { description: 'Record a decision, todo, or open question for future sessions.', inputSchema: { text: z.string(), kind: z.enum(['decision', 'todo', 'question']).optional() } }, wrap('session_note'))
  server.registerTool('index_refresh', { description: 'Rebuild the repo index (incremental by default, full with full=true).', inputSchema: { full: z.boolean().optional() } }, wrap('index_refresh'))

  return server
}
