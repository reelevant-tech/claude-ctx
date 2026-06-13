import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../config'
import { splitIdentifier } from '../tokens'
import { acquireLock, releaseLock } from '../store/lock'
import {
  clearPending,
  loadPending,
  loadShard,
  saveShard,
} from '../store/shards'
import type {
  CallRef,
  CallsShard,
  CommandsShard,
  CtxConfig,
  FileRecord,
  FilesShard,
  GitShard,
  GraphShard,
  IndexMeta,
  IndexStats,
  PackageInfo,
  ParseResult,
  SymbolNode,
  SymbolRecord,
  SymbolsShard,
  SymbolTreeShard,
} from '../types'
import { rmSync } from 'node:fs'
import { gitIdentity } from '../git'
import { legacyIndexDir, repoId, repoIdentity, repoJsonPath } from '../paths'
import { writeFileAtomic } from '../store/shards'
import { extractRust } from '../ast/rust'
import { extractTsTree } from '../ast/ts-tree'
import { extractCommands } from './commands'
import { assignPackage, detectProject } from './detect'
import { buildGraph } from './graph'
import { collectGitSignals, headCommit } from './gitsig'
import { parseLexical } from './parse-lexical'
import { parseRust } from './parse-rust'
import { parseTs } from './parse-ts'
import { buildResolverContext, resolveImport } from './resolve'
import { classifyRisk, INFRA_GLOBS, SECRET_GLOBS } from './risk'
import { detectLang, isBinaryBuffer, scanRepo, type ScannedFile } from './scan'
import { mapTests } from './tests'
import { buildTreeSummary } from './tree'

interface ProcessedFile {
  rel: string
  record: FileRecord
  parse: ParseResult | null
  tree?: SymbolNode[]
  calls?: CallRef[]
  treeParser?: 'ts-api' | 'tree-sitter'
}

const RUST_RESERVED = new Set(['crate', 'super', 'self', 'std', 'core', 'alloc', 'Self'])

/** Top-level package/crate name an unresolved import refers to, or null if not external. */
function externalDepName(spec: string, lang: FileRecord['lang']): string | null {
  if (lang === 'rust') {
    const first = spec.split('::')[0]
    if (!first || RUST_RESERVED.has(first)) return null
    return first
  }
  // ts/js
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? null
  }
  return spec.split('/')[0] ?? null
}

function hash12(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12)
}

/** Build a single file record (+ parse result, symbol tree, calls). Never throws. */
async function processFile(
  root: string,
  sf: ScannedFile,
  cfg: CtxConfig,
  packages: PackageInfo[],
): Promise<ProcessedFile | null> {
  const rel = sf.rel
  const lang = detectLang(rel)
  const pkg = assignPackage(rel, packages)
  const entry = pkg >= 0 && packages[pkg]?.entrypoints.includes(rel) === true
  const { kind: riskKind, risk } = classifyRisk(rel, cfg)

  const base = (k: FileRecord['kind'], parser: FileRecord['parser']): FileRecord => ({
    h: '',
    mtime: sf.mtime,
    size: sf.size,
    lines: 0,
    lang,
    pkg,
    parser,
    kind: k,
    risk: [...risk],
    entry,
    exports: [],
    externalDeps: [],
    docHeadings: [],
    tests: [],
  })

  // Secret files: never read content.
  if (riskKind === 'secret') {
    return { rel, record: base('secret', 'none'), parse: null }
  }

  let content: string
  let buf: Buffer
  try {
    buf = readFileSync(sf.abs)
  } catch {
    return null // unreadable — skip + count by caller
  }
  if (isBinaryBuffer(buf)) {
    const r = base('asset', 'none')
    r.kind = riskKind ?? 'asset'
    return { rel, record: r, parse: null }
  }
  content = buf.toString('utf8')
  const lines = content.length === 0 ? 0 : content.split('\n').length

  // Parse by language.
  let parse: ParseResult | null = null
  let parser: FileRecord['parser'] = 'none'
  let defaultKind: FileRecord['kind'] = 'source'
  let tree: SymbolNode[] | undefined
  let calls: CallRef[] | undefined
  let treeParser: 'ts-api' | 'tree-sitter' | undefined
  if (lang === 'ts' || lang === 'js') {
    try {
      parse = parseTs(content, rel)
      parser = 'ts-api'
    } catch {
      parse = parseLexical(content, lang)
      parser = 'lexical'
    }
    try {
      const t = extractTsTree(content, rel)
      tree = t.tree
      calls = t.calls
      treeParser = 'ts-api'
    } catch {
      /* tree is best-effort */
    }
  } else if (lang === 'rust') {
    // prefer tree-sitter; fall back to the regex parser (fail-open)
    const rx = await extractRust(content).catch(() => null)
    if (rx) {
      parse = rx.result
      parser = 'rust'
      tree = rx.tree
      calls = rx.calls
      treeParser = 'tree-sitter'
    } else {
      parse = parseRust(content)
      parser = 'rust'
    }
  } else if (lang === 'md') {
    parse = parseLexical(content, 'md')
    parser = 'lexical'
    defaultKind = 'doc'
  } else if (lang === 'json' || lang === 'toml' || lang === 'yaml') {
    defaultKind = 'config'
  } else {
    defaultKind = 'asset'
  }

  const rec = base(riskKind ?? defaultKind, parser)
  rec.h = hash12(content)
  rec.lines = lines
  if (lines > 3000 && !rec.risk.includes('huge')) rec.risk.push('huge')
  if (parse) {
    rec.exports = parse.exports.slice(0, 30)
    rec.docHeadings = parse.docHeadings.slice(0, 10)
    // rust files with inline #[cfg(test)] test themselves
    if (lang === 'rust' && parse.hasCfgTest) rec.tests.push(rel)
  }
  const pf: ProcessedFile = { rel, record: rec, parse }
  if (tree) pf.tree = tree
  if (calls) pf.calls = calls
  if (treeParser) pf.treeParser = treeParser
  return pf
}

/** Resolve imports for all files, populate fwd edges and externalDeps (mutates records). */
function resolveEdges(
  root: string,
  fileSet: Set<string>,
  packages: PackageInfo[],
  records: Map<string, FileRecord>,
  importsByFile: Map<string, string[]>,
  modDeclsByFile: Map<string, string[]>,
): Map<string, Set<string>> {
  const ctx = buildResolverContext(root, fileSet, packages, modDeclsByFile)
  const fwd = new Map<string, Set<string>>()
  for (const [rel, imports] of importsByFile) {
    const rec = records.get(rel)
    if (!rec) continue
    const edges = new Set<string>()
    const ext: string[] = []
    const extSeen = new Set<string>()
    for (const spec of imports) {
      const target = resolveImport(rel, spec, ctx)
      if (target && target !== rel && fileSet.has(target)) {
        edges.add(target)
      } else if (!target) {
        const name = externalDepName(spec, rec.lang)
        if (name && !extSeen.has(name)) {
          extSeen.add(name)
          ext.push(name)
        }
      }
    }
    if (edges.size > 0) fwd.set(rel, edges)
    rec.externalDeps = ext.slice(0, 15)
  }
  return fwd
}

function buildSymbolsShard(records: Map<string, FileRecord>, parses: Map<string, ParseResult>): SymbolsShard {
  const symbols: SymbolRecord[] = []
  for (const rel of [...parses.keys()].sort()) {
    const parse = parses.get(rel)!
    for (const s of parse.symbols) {
      const sym: SymbolRecord = { n: s.n, k: s.k, f: rel, l: s.l, x: s.x, sig: s.sig }
      if (s.m) sym.m = s.m
      symbols.push(sym)
    }
  }
  const tokenIndex: Record<string, number[]> = Object.create(null)
  symbols.forEach((s, i) => {
    const toks = new Set<string>([s.n.toLowerCase(), ...splitIdentifier(s.n)])
    for (const t of toks) {
      if (t.length < 2) continue
      ;(tokenIndex[t] ??= []).push(i)
    }
  })
  for (const t of Object.keys(tokenIndex)) {
    tokenIndex[t] = [...new Set(tokenIndex[t]!)].sort((a, b) => a - b)
  }
  return { symbols, tokenIndex }
}

function applyGitSignals(root: string, cfg: CtxConfig, records: Map<string, FileRecord>): GitShard {
  const known = new Set(records.keys())
  const sig = collectGitSignals(root, cfg, known)
  for (const [rel, info] of sig.perFile) {
    const rec = records.get(rel)
    if (rec) rec.git = info
  }
  return sig.shard
}

/** Re-derive tests/testedBy across the whole record set, preserving rust self-tests. */
function remapTests(records: Map<string, FileRecord>, packages: PackageInfo[], fwd: Record<string, string[]>): void {
  const selfTest = new Set<string>()
  for (const [rel, rec] of records) if (rec.tests.includes(rel)) selfTest.add(rel)
  for (const rec of records.values()) {
    rec.tests = []
    rec.testedBy = undefined
  }
  for (const rel of selfTest) records.get(rel)!.tests.push(rel)
  const obj: Record<string, FileRecord> = {}
  for (const [k, v] of records) obj[k] = v
  mapTests(obj, packages, fwd)
}

function writeShards(
  root: string,
  meta: IndexMeta,
  files: FilesShard,
  symbols: SymbolsShard,
  graph: GraphShard,
  git: GitShard,
  commands: CommandsShard,
  symtree: SymbolTreeShard,
  calls: CallsShard,
): void {
  // meta written LAST — its presence marks a usable index
  saveShard(root, 'files', files)
  saveShard(root, 'symbols', symbols)
  saveShard(root, 'graph', graph)
  saveShard(root, 'git', git)
  saveShard(root, 'commands', commands)
  saveShard(root, 'symtree', symtree)
  saveShard(root, 'calls', calls)
  saveShard(root, 'meta', meta)
  clearPending(root)
}

/** Persist repo-level identity (one per repo, shared across branches). */
function writeRepoJson(root: string, meta: IndexMeta): void {
  if (!meta.repo) return
  writeFileAtomic(repoJsonPath(root), JSON.stringify(meta.repo))
}

/** Remove the pre-branch-keyed index dir so it can't be confused with the new layout. */
function dropLegacyIndex(root: string): void {
  try {
    rmSync(legacyIndexDir(root), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

export async function buildIndex(
  root: string,
  opts?: { mode?: 'full' | 'incremental'; config?: CtxConfig },
): Promise<IndexStats> {
  const cfg = opts?.config ?? loadConfig(root)
  const existing = loadShard<IndexMeta>(root, 'meta')
  const wantIncremental = opts?.mode === 'incremental' || (opts?.mode === undefined && existing !== null)
  if (wantIncremental && existing) {
    const inc = await tryIncremental(root, cfg, existing)
    if (inc) return inc
  }
  return fullBuild(root, cfg)
}

async function fullBuild(root: string, cfg: CtxConfig): Promise<IndexStats> {
  const started = Date.now()
  if (!acquireLock(root)) {
    return { fileCount: 0, skippedCount: 0, symbolCount: 0, durationMs: 0, mode: 'noop' }
  }
  try {
    const scan = scanRepo(root, cfg)
    const { projectType, packages } = detectProject(root, scan.files)

    const records = new Map<string, FileRecord>()
    const parses = new Map<string, ParseResult>()
    const importsByFile = new Map<string, string[]>()
    const modDeclsByFile = new Map<string, string[]>()
    const trees: Record<string, SymbolNode[]> = {}
    const treeParsers: Record<string, 'ts-api' | 'tree-sitter' | 'none'> = {}
    const callsByFile: Record<string, CallRef[]> = {}
    let skipped = scan.skippedCount

    for (const sf of scan.files) {
      const pf = await processFile(root, sf, cfg, packages)
      if (!pf) {
        skipped++
        continue
      }
      records.set(pf.rel, pf.record)
      if (pf.parse) {
        parses.set(pf.rel, pf.parse)
        importsByFile.set(pf.rel, pf.parse.imports)
        if (pf.parse.modDecls) modDeclsByFile.set(pf.rel, pf.parse.modDecls)
      }
      if (pf.tree) {
        trees[pf.rel] = pf.tree
        treeParsers[pf.rel] = pf.treeParser ?? 'none'
      }
      if (pf.calls && pf.calls.length > 0) callsByFile[pf.rel] = pf.calls
    }

    const fileSet = new Set(records.keys())
    const fwdMap = resolveEdges(root, fileSet, packages, records, importsByFile, modDeclsByFile)
    const graph = buildGraph(fwdMap)
    const git = applyGitSignals(root, cfg, records)
    remapTests(records, packages, graph.fwd)

    const filesObj: Record<string, FileRecord> = {}
    for (const k of [...records.keys()].sort()) filesObj[k] = records.get(k)!
    const filesShard: FilesShard = { files: filesObj }
    const symbols = buildSymbolsShard(records, parses)
    const commands = extractCommands(root, packages)
    const treeSummary = buildTreeSummary(scan.files.map((f) => ({ rel: f.rel })))

    const meta: IndexMeta = {
      version: 1,
      root,
      repoId: repoId(root),
      indexedAt: Math.floor(started / 1000),
      indexDurationMs: Date.now() - started,
      fileCount: records.size,
      skippedCount: skipped,
      isGit: scan.isGit,
      projectType,
      packages,
      treeSummary,
      riskyGlobs: [...INFRA_GLOBS, ...cfg.riskyGlobs],
      secretGlobs: [...SECRET_GLOBS, ...cfg.secretGlobs],
    }
    const hc = headCommit(root)
    if (hc) meta.headCommit = hc
    meta.repo = repoIdentity(root)
    meta.gitId = gitIdentity(root)

    writeShards(root, meta, filesShard, symbols, graph, git, commands, { trees, parsers: treeParsers }, { calls: callsByFile })
    writeRepoJson(root, meta)
    dropLegacyIndex(root)
    return {
      fileCount: records.size,
      skippedCount: skipped,
      symbolCount: symbols.symbols.length,
      durationMs: Date.now() - started,
      mode: 'full',
    }
  } finally {
    releaseLock(root)
  }
}

async function tryIncremental(root: string, cfg: CtxConfig, meta: IndexMeta): Promise<IndexStats | null> {
  const filesShard = loadShard<FilesShard>(root, 'files')
  if (!filesShard) return null
  const started = Date.now()
  if (!acquireLock(root)) {
    return { fileCount: meta.fileCount, skippedCount: 0, symbolCount: 0, durationMs: 0, mode: 'noop' }
  }
  try {
    const scan = scanRepo(root, cfg)
    const scanByRel = new Map(scan.files.map((f) => [f.rel, f]))
    const old = filesShard.files
    const pending = loadPending(root).dirty.filter((f) => scanByRel.has(f))

    const changed: ScannedFile[] = []
    for (const sf of scan.files) {
      const rec = old[sf.rel]
      if (!rec || rec.mtime !== sf.mtime || rec.size !== sf.size || pending.includes(sf.rel)) {
        changed.push(sf)
      }
    }
    const deleted = Object.keys(old).filter((rel) => !scanByRel.has(rel))

    if (changed.length === 0 && deleted.length === 0) {
      clearPending(root)
      return { fileCount: meta.fileCount, skippedCount: 0, symbolCount: 0, durationMs: Date.now() - started, mode: 'noop' }
    }

    // Re-process changed files.
    const records = new Map<string, FileRecord>()
    for (const [rel, rec] of Object.entries(old)) {
      if (!deleted.includes(rel)) records.set(rel, rec)
    }
    const newParses = new Map<string, ParseResult>()
    const importsByFile = new Map<string, string[]>()
    const newTrees = new Map<string, { tree: SymbolNode[]; parser: 'ts-api' | 'tree-sitter' | 'none' }>()
    const newCalls = new Map<string, CallRef[]>()
    for (const sf of changed) {
      const pf = await processFile(root, sf, cfg, meta.packages)
      if (!pf) {
        records.delete(sf.rel)
        continue
      }
      records.set(pf.rel, pf.record)
      if (pf.parse) {
        newParses.set(pf.rel, pf.parse)
        importsByFile.set(pf.rel, pf.parse.imports)
      }
      if (pf.tree) newTrees.set(pf.rel, { tree: pf.tree, parser: pf.treeParser ?? 'none' })
      newCalls.set(pf.rel, pf.calls ?? [])
    }

    const fileSet = new Set(records.keys())
    const rustInvolved =
      changed.some((s) => detectLang(s.rel) === 'rust') || deleted.some((d) => detectLang(d) === 'rust')

    // rebuild rust module map only when rust is involved (documented simplification)
    const modDeclsByFile = new Map<string, string[]>()
    if (rustInvolved) {
      for (const rel of fileSet) {
        if (detectLang(rel) !== 'rust') continue
        const fresh = newParses.get(rel)
        if (fresh?.modDecls) {
          modDeclsByFile.set(rel, fresh.modDecls)
        } else {
          const sf = scanByRel.get(rel)
          if (!sf) continue
          try {
            const p = parseRust(readFileSync(sf.abs, 'utf8'))
            if (p.modDecls) modDeclsByFile.set(rel, p.modDecls)
            // also need imports for re-resolution of unchanged rust files? only changed ones re-resolve
          } catch {
            /* skip */
          }
        }
      }
    }

    // Start from existing resolved fwd, drop changed+deleted as sources, re-resolve changed.
    const oldGraph = loadShard<GraphShard>(root, 'graph') ?? { fwd: {}, rev: {}, centrality: {} }
    const fwdMap = new Map<string, Set<string>>()
    const dropSet = new Set([...changed.map((c) => c.rel), ...deleted])
    for (const [src, targets] of Object.entries(oldGraph.fwd)) {
      if (dropSet.has(src) || !fileSet.has(src)) continue
      fwdMap.set(src, new Set(targets.filter((t) => fileSet.has(t))))
    }
    const ctx = buildResolverContext(root, fileSet, meta.packages, modDeclsByFile)
    for (const [rel, imports] of importsByFile) {
      const rec = records.get(rel)
      if (!rec) continue
      const edges = new Set<string>()
      const ext: string[] = []
      const extSeen = new Set<string>()
      for (const spec of imports) {
        const target = resolveImport(rel, spec, ctx)
        if (target && target !== rel && fileSet.has(target)) edges.add(target)
        else if (!target) {
          const name = externalDepName(spec, rec.lang)
          if (name && !extSeen.has(name)) {
            extSeen.add(name)
            ext.push(name)
          }
        }
      }
      if (edges.size > 0) fwdMap.set(rel, edges)
      else fwdMap.delete(rel)
      rec.externalDeps = ext.slice(0, 15)
    }
    const graph = buildGraph(fwdMap)

    // Refresh git only when HEAD moved.
    const hc = headCommit(root)
    let git = loadShard<GitShard>(root, 'git') ?? { recent: [], churn: {}, cochange: {} }
    if (hc !== (meta.headCommit ?? null)) {
      git = applyGitSignals(root, cfg, records)
    }

    remapTests(records, meta.packages, graph.fwd)

    // Rebuild symbols from existing symbol shard minus changed/deleted, plus new.
    const symbols = rebuildSymbolsIncremental(root, records, newParses, dropSet)

    const filesObj: Record<string, FileRecord> = {}
    for (const k of [...records.keys()].sort()) filesObj[k] = records.get(k)!
    const treeSummary = buildTreeSummary([...records.keys()].sort().map((rel) => ({ rel })))

    const newMeta: IndexMeta = {
      ...meta,
      indexedAt: Math.floor(started / 1000),
      indexDurationMs: Date.now() - started,
      fileCount: records.size,
      treeSummary,
    }
    if (hc) newMeta.headCommit = hc
    else delete newMeta.headCommit
    delete newMeta.partial
    newMeta.repo = repoIdentity(root)
    newMeta.gitId = gitIdentity(root)

    // Patch symtree/calls: keep entries for surviving files, replace changed ones.
    const oldSymtree = loadShard<SymbolTreeShard>(root, 'symtree') ?? { trees: {}, parsers: {} }
    const oldCalls = loadShard<CallsShard>(root, 'calls') ?? { calls: {} }
    const trees: Record<string, SymbolNode[]> = {}
    const treeParsers: Record<string, 'ts-api' | 'tree-sitter' | 'none'> = {}
    const callsByFile: Record<string, CallRef[]> = {}
    for (const rel of records.keys()) {
      if (newTrees.has(rel)) {
        trees[rel] = newTrees.get(rel)!.tree
        treeParsers[rel] = newTrees.get(rel)!.parser
      } else if (oldSymtree.trees[rel]) {
        trees[rel] = oldSymtree.trees[rel]!
        treeParsers[rel] = oldSymtree.parsers[rel] ?? 'none'
      }
      if (newCalls.has(rel)) {
        const c = newCalls.get(rel)!
        if (c.length > 0) callsByFile[rel] = c
      } else if (oldCalls.calls[rel]) {
        callsByFile[rel] = oldCalls.calls[rel]!
      }
    }

    const commands = extractCommands(root, meta.packages)
    writeShards(root, newMeta, { files: filesObj }, symbols, graph, git, commands, { trees, parsers: treeParsers }, { calls: callsByFile })
    writeRepoJson(root, newMeta)
    return {
      fileCount: records.size,
      skippedCount: scan.skippedCount,
      symbolCount: symbols.symbols.length,
      durationMs: Date.now() - started,
      mode: 'incremental',
    }
  } finally {
    releaseLock(root)
  }
}

function rebuildSymbolsIncremental(
  root: string,
  records: Map<string, FileRecord>,
  newParses: Map<string, ParseResult>,
  dropSet: Set<string>,
): SymbolsShard {
  const oldShard = loadShard<SymbolsShard>(root, 'symbols') ?? { symbols: [], tokenIndex: {} }
  const kept = oldShard.symbols.filter((s) => !dropSet.has(s.f) && records.has(s.f))
  const fresh: SymbolRecord[] = []
  for (const rel of [...newParses.keys()].sort()) {
    for (const s of newParses.get(rel)!.symbols) {
      const sym: SymbolRecord = { n: s.n, k: s.k, f: rel, l: s.l, x: s.x, sig: s.sig }
      if (s.m) sym.m = s.m
      fresh.push(sym)
    }
  }
  const all = [...kept, ...fresh].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : a.l - b.l))
  const tokenIndex: Record<string, number[]> = Object.create(null)
  all.forEach((s, i) => {
    const toks = new Set<string>([s.n.toLowerCase(), ...splitIdentifier(s.n)])
    for (const t of toks) {
      if (t.length < 2) continue
      ;(tokenIndex[t] ??= []).push(i)
    }
  })
  for (const t of Object.keys(tokenIndex)) tokenIndex[t] = [...new Set(tokenIndex[t]!)].sort((a, b) => a - b)
  return { symbols: all, tokenIndex }
}
