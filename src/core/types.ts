/**
 * claude-ctx — shared schemas. Every module builds against this file.
 *
 * Conventions:
 *  - All file paths stored in shards are repo-root-relative POSIX paths ("src/a.ts").
 *  - All timestamps are unix epoch SECONDS.
 *  - Shards are plain JSON files under ~/.claude-ctx/repos/<repoId>/index/.
 */

// ---------------------------------------------------------------------------
// Languages / classification
// ---------------------------------------------------------------------------

export type Lang = 'ts' | 'js' | 'rust' | 'py' | 'md' | 'json' | 'toml' | 'yaml' | 'other'

export type FileKind =
  | 'source'
  | 'test'
  | 'config'
  | 'doc'
  | 'generated'
  | 'vendor'
  | 'infra'
  | 'secret'
  | 'asset'

export type RiskTag = 'generated' | 'vendor' | 'infra' | 'secret' | 'huge'

export type ProjectType =
  | 'ts-app'
  | 'ts-monorepo'
  | 'rust-crate'
  | 'rust-workspace'
  | 'multi' // multiple nested manifests, no root workspace
  | 'mixed' // both ts and rust packages
  | 'unknown'

export type SymbolKind =
  | 'fn'
  | 'method'
  | 'class'
  | 'iface'
  | 'type'
  | 'enum'
  | 'const'
  | 'var'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'mod'
  | 'macro'

// ---------------------------------------------------------------------------
// Index shards
// ---------------------------------------------------------------------------

/** Bump when the vector shard layout changes incompatibly. */
export const VECTOR_SCHEMA_VERSION = 2

/** Stable repository identity, stored in every index + vector shard. */
export interface RepoIdentity {
  repoId: string
  repoName: string
  /** the actual git top-level root (never the workspace launch dir) */
  repoRoot: string
  remoteUrl?: string
}

/** Git state captured at index time. */
export interface GitIdentity {
  branch?: string
  /** filesystem-safe key derived from branch (or detached commit) */
  branchKey: string
  headCommit?: string
  /** worktree had uncommitted changes at index time (provenance, not freshness) */
  dirty: boolean
  /** ISO timestamp */
  indexedAt: string
}

export interface PackageInfo {
  id: number
  name: string
  /** repo-relative dir, '' for repo root */
  dir: string
  kind: 'npm' | 'cargo'
  /** repo-relative path to package.json / Cargo.toml */
  manifest: string
  /** repo-relative entrypoint files */
  entrypoints: string[]
}

export interface IndexMeta {
  version: 1
  /** absolute repo root */
  root: string
  repoId: string
  indexedAt: number
  indexDurationMs: number
  fileCount: number
  skippedCount: number
  isGit: boolean
  projectType: ProjectType
  packages: PackageInfo[]
  /** compact pre-rendered tree (<= ~60 lines), for overview injection */
  treeSummary: string
  /** effective merged risky globs (built-in + config), for cheap guard hooks */
  riskyGlobs: string[]
  /** effective merged secret globs, for cheap guard hooks */
  secretGlobs: string[]
  /** HEAD commit hash at index time (git repos only) */
  headCommit?: string
  /** true while a background full build is still running */
  partial?: boolean
  /** stable repo identity (added with branch-keyed indexing) */
  repo?: RepoIdentity
  /** git state at index time */
  gitId?: GitIdentity
}

export interface FileGitInfo {
  /** last commit touching this file (epoch seconds) */
  lastTs: number
  /** commits touching this file within the analyzed window */
  commits: number
}

export interface FileRecord {
  /** sha1 of content, first 12 hex chars ('' when content not read, e.g. secret) */
  h: string
  mtime: number
  size: number
  lines: number
  lang: Lang
  /** PackageInfo.id, -1 if not inside any package */
  pkg: number
  parser: 'ts-api' | 'rust' | 'python' | 'lexical' | 'none'
  kind: FileKind
  risk: RiskTag[]
  entry: boolean
  /** exported/pub top-level identifiers (capped 30) */
  exports: string[]
  /** external (non-repo) imports: npm package names / crate names (capped 15) */
  externalDeps: string[]
  /** markdown headings (md files only, capped 10) */
  docHeadings: string[]
  git?: FileGitInfo
  /** repo-relative test files covering this file */
  tests: string[]
  /** for kind=test files: the source file this tests, if known */
  testedBy?: string
}

export interface FilesShard {
  files: Record<string, FileRecord>
}

export interface SymbolRecord {
  /** name */
  n: string
  k: SymbolKind
  /** repo-relative file */
  f: string
  /** 1-based line */
  l: number
  /** exported / pub */
  x: boolean
  /** single-line declaration text, truncated to 120 chars */
  sig: string
  /** rust module path like "billing::invoice" (rust only) */
  m?: string
}

export interface SymbolsShard {
  symbols: SymbolRecord[]
  /** lowercase token -> indexes into symbols[] */
  tokenIndex: Record<string, number[]>
}

export interface GraphShard {
  /** file -> files it imports (repo-relative, resolved) */
  fwd: Record<string, string[]>
  /** file -> files importing it */
  rev: Record<string, string[]>
  /** file -> rev count (precomputed) */
  centrality: Record<string, number>
}

export interface RecentChange {
  f: string
  ts: number
  subject: string
}

export interface GitShard {
  /** most recently changed files (deduped, newest first, capped 50) */
  recent: RecentChange[]
  /** file -> commit count in window */
  churn: Record<string, number>
  /** file -> top co-changed [file, count] pairs (count>=2, capped 10) */
  cochange: Record<string, [string, number][]>
}

export interface CommandInfo {
  /** runnable command, e.g. "pnpm test", "cargo test -p poker-core" */
  cmd: string
  /** provenance, e.g. "package.json:scripts.test", "Makefile:lint" */
  src: string
  kind: 'test' | 'build' | 'dev' | 'lint' | 'typecheck' | 'run' | 'other'
  /** PackageInfo.id when package-scoped */
  pkg?: number
}

export interface CommandsShard {
  commands: CommandInfo[]
}

export interface PendingShard {
  /** repo-relative files edited since last index */
  dirty: string[]
  since: number
}

export type ShardName =
  | 'meta'
  | 'files'
  | 'symbols'
  | 'graph'
  | 'git'
  | 'commands'
  | 'pending'
  | 'vectors'
  | 'symtree'
  | 'calls'
  | 'fieldaccess'

/** A node in a per-file symbol tree (nested: mod>impl>method, class>method, …). */
export interface SymbolNode {
  /** name */
  n: string
  k: SymbolKind
  /** 1-based start line */
  l: number
  /** 1-based end line */
  endL: number
  /** exported / pub */
  x: boolean
  /** single-line declaration text, truncated to 120 chars */
  sig: string
  children?: SymbolNode[]
}

/** Per-file nested symbol trees (P0). Built via the TS compiler AST / tree-sitter. */
export interface SymbolTreeShard {
  /** repo-relative file -> top-level symbol nodes */
  trees: Record<string, SymbolNode[]>
  /** parser used per file, for transparency */
  parsers: Record<string, 'ts-api' | 'tree-sitter' | 'none'>
}

/** A call expression observed inside a file (best-effort, intra-file). */
export interface CallRef {
  /** called function/method name (best-effort: trailing identifier of the callee) */
  callee: string
  /** 1-based line */
  line: number
  /** enclosing top-level/nested symbol name, if known */
  caller?: string
}

/** Per-file intra-file call expressions (P1, best-effort). */
export interface CallsShard {
  calls: Record<string, CallRef[]>
}

/** A member/field access observed in a file (best-effort, name-based). */
export interface FieldRef {
  /** accessed property/field name */
  field: string
  /** 1-based line */
  line: number
  /** read = obj.field; write = obj.field = … / {field: x} / {field}; destructure = const {field} = … */
  kind: 'read' | 'write' | 'destructure'
  /** enclosing top-level/nested symbol name, if known */
  caller?: string
}

/** Per-file member/field accesses (data-flow, best-effort name-based; typed refs resolved on demand). */
export interface FieldAccessShard {
  fieldAccesses: Record<string, FieldRef[]>
}

/** One embedded chunk: a whole file (symbol undefined) or a single symbol.
 * repo/branch fields duplicate the shard header so each entry is self-attributing
 * (the shard-level RepoIdentity/GitIdentity is the source of truth). */
export interface VectorEntry {
  /** repo-relative file */
  path: string
  /** symbol name; undefined = file-level chunk */
  symbol?: string
  kind?: SymbolKind
  /** 1-based line span of the chunk (whole file for file-level) */
  startLine: number
  endLine: number
  /** file content hash (incremental reuse) */
  fileHash?: string
  /** hash of the embedded text (per-chunk freshness) */
  chunkHash?: string
  repoId?: string
  repoName?: string
  repoRoot?: string
  branch?: string
  branchKey?: string
  headCommit?: string
  /** base64 of an L2-normalized Float32Array(dim); cosine = dot product */
  vec: string
}

/** Optional semantic layer. Symbol-level + file-level chunks; cosine = dot
 * product (vectors are L2-normalized). Incremental re-embed is keyed by `hashes`
 * (re-embed a file only when its content hash changes). */
export interface VectorsShard {
  /** layout version; query refuses to use a shard from an older schema */
  schemaVersion?: number
  repo?: RepoIdentity
  gitId?: GitIdentity
  model: string
  dim: number
  /** epoch seconds when the shard was last (re)built */
  createdAt: number
  /** HEAD commit at build time, for staleness/branch diagnostics (git repos) */
  headCommit?: string
  /** repo-relative file -> content hash at embed time (drives incremental reuse) */
  hashes: Record<string, string>
  entries: VectorEntry[]
}

/** Everything the router / MCP server needs, loaded in memory. */
export interface LoadedIndex {
  meta: IndexMeta
  files: FilesShard
  symbols: SymbolsShard
  graph: GraphShard
  git: GitShard
  commands: CommandsShard
  /** present only when the optional embeddings layer has been built */
  vectors?: VectorsShard
}

// ---------------------------------------------------------------------------
// Parsing (per-file extractor output; orchestrator fills in file paths)
// ---------------------------------------------------------------------------

export interface ParsedSymbol {
  n: string
  k: SymbolKind
  l: number
  x: boolean
  sig: string
  /** rust module path within the file (e.g. "tests"), '' at file top level */
  m?: string
}

export interface ParseResult {
  symbols: ParsedSymbol[]
  /** raw import specifiers: TS module specifiers or rust `use` paths */
  imports: string[]
  /** exported/pub identifier names */
  exports: string[]
  /** markdown headings (md only) */
  docHeadings: string[]
  /** rust: file contains #[cfg(test)] */
  hasCfgTest?: boolean
  /** rust: `mod foo;` declarations (external module files) */
  modDecls?: string[]
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type GuardMode = 'enforce' | 'warn' | 'off'

export interface CtxConfig {
  packBudgetTokens: number
  overviewBudgetTokens: number
  inject: {
    sessionStart: boolean
    userPromptSubmit: boolean
  }
  guard: {
    bash: GuardMode
    edits: GuardMode
    reads: GuardMode
  }
  /** extra exclude globs (added to built-in hard excludes) */
  exclude: string[]
  /** extra risky globs (treated as infra) */
  riskyGlobs: string[]
  /** extra secret globs */
  secretGlobs: string[]
  maxFileSizeKb: number
  maxFiles: number
  /** repos above this file count index in a detached background process */
  bgIndexThresholdFiles: number
  mcpMaxResultTokens: number
  /** how many commits `git log` analyzes for signals */
  cochangeCommits: number
  /** per-repo query-token aliases (folded lowercase key -> alias terms), merged
   * over the built-in FR→EN/synonym map. Use for domain jargon (binding→dependency). */
  tokenAliases?: Record<string, string[]>
  /** inject a file's related neighbourhood (imports/importers/tests/co-changed)
   * as additionalContext after each Read, so the model gets structure without
   * cascading. Default true. */
  relatedOnRead?: boolean
  /** after this many consecutive manual Reads with no index query, nudge toward
   * mcp__ctx__context_pack. Default 3. */
  cascadeReadLimit?: number
  /** optional local-embeddings (offline semantic retrieval) layer */
  embeddings: {
    enabled: boolean
    /** transformers.js model id (downloaded once, then cached offline) */
    model: string
    /** hybrid fusion weight: semantic boost = weight * 100 * max(0, cosine - floor) */
    weight: number
    /** prefix prepended to a QUERY before embedding (e5/nomic need this, e.g. "query: ") */
    queryPrefix?: string
    /** prefix prepended to a PASSAGE/chunk before embedding (e.g. "passage: ") */
    passagePrefix?: string
  }
}

// ---------------------------------------------------------------------------
// Session memory
// ---------------------------------------------------------------------------

export type SessionEvent =
  | { ts: number; e: 'prompt'; text: string }
  | { ts: number; e: 'read'; f: string }
  | { ts: number; e: 'edit'; f: string; tool: string }
  | { ts: number; e: 'bash'; cmd: string; exit?: number }
  | { ts: number; e: 'note'; text: string; kind?: 'decision' | 'todo' | 'question' }
  | { ts: number; e: 'guard'; kind: 'deny' | 'ask' | 'warn'; target: string }
  | { ts: number; e: 'mcp'; tool: string }

export interface SessionState {
  /** repo-relative path -> read count (LRU-capped at 500 entries) */
  reads: Record<string, number>
  edits: string[]
  /** files whose "read the tests" nudge already fired */
  testsReminded: string[]
  firstPrompt?: string
  updatedAt: number
  /** consecutive manual Reads since the last index query (context_pack/etc.) */
  readStreak?: number
  /** epoch seconds of the last mcp__ctx__* query, if any */
  indexQueriedAt?: number
  /** files whose auto-expand "related" neighborhood was already injected */
  relatedShown?: string[]
}

export interface SessionSummaryEntry {
  id: string
  endedAt: number
  /** first user prompt, truncated to 200 chars */
  task: string
  filesEdited: string[]
  /** top 10 by read count */
  filesInspected: string[]
  /** "cmd (exit N)" strings, capped 10 */
  commands: string[]
  /** session_note texts */
  notes: string[]
  guardEvents: number
}

export interface RepoSummary {
  updatedAt: number
  /** last 5 sessions, newest first */
  sessions: SessionSummaryEntry[]
}

// ---------------------------------------------------------------------------
// Router / context pack
// ---------------------------------------------------------------------------

export interface ScoreReason {
  reason: string
  points: number
}

export interface ScoredFile {
  path: string
  score: number
  reasons: ScoreReason[]
}

export interface PackFile {
  path: string
  score: number
  why: string[]
  /** top symbol signatures */
  symbols: string[]
  tests: string[]
  risk: RiskTag[]
}

export interface PackExcerpt {
  path: string
  /** "40-52" */
  lines: string
  /** redacted */
  text: string
}

export interface ContextPack {
  task: string
  confidence: 'high' | 'medium' | 'low'
  tokensUsed: number
  budget: number
  files: PackFile[]
  /** "src/a.ts → src/b.ts" lines */
  depLinks: string[]
  excerpts: PackExcerpt[]
  missing?: string
  nextStep?: string
  alreadyInspected: string[]
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export type GuardTier = 'severe' | 'destructive' | 'inefficient'

export interface GuardVerdict {
  tier: GuardTier
  /** short human reason, e.g. "reads secret file .env" */
  reason: string
  /** concrete alternative, e.g. "use mcp__ctx__symbol_search('foo')" */
  suggestion?: string
  /** rule identifier for logging, e.g. "secret-read" */
  rule: string
}

// ---------------------------------------------------------------------------
// Hook I/O (Claude Code hook protocol)
// ---------------------------------------------------------------------------

export interface HookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  permission_mode?: string
  /** UserPromptSubmit */
  prompt?: string
  /** SessionStart: startup|resume|clear|compact */
  source?: string
  /** PreToolUse / PostToolUse */
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_output?: unknown
  /** Stop */
  stop_hook_active?: boolean
}

export interface HookSpecificOutput {
  hookEventName: string
  additionalContext?: string
  /** PreToolUse only — claude-ctx NEVER emits 'allow' (would bypass user permission flow) */
  permissionDecision?: 'deny' | 'ask'
  permissionDecisionReason?: string
}

export interface HookOutput {
  hookSpecificOutput?: HookSpecificOutput
  systemMessage?: string
  suppressOutput?: boolean
}

// ---------------------------------------------------------------------------
// Indexer orchestrator API
// ---------------------------------------------------------------------------

export interface IndexStats {
  fileCount: number
  skippedCount: number
  symbolCount: number
  durationMs: number
  mode: 'full' | 'incremental' | 'noop'
}

export interface EnsureIndexResult {
  /** 'fresh' = usable; 'building' = background build started/running; 'missing' = no index, none started */
  status: 'fresh' | 'building' | 'missing'
  stats?: IndexStats
}
