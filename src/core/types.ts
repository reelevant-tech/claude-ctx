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

export type Lang = 'ts' | 'js' | 'rust' | 'md' | 'json' | 'toml' | 'yaml' | 'other'

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
  parser: 'ts-api' | 'rust' | 'lexical' | 'none'
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

export type ShardName = 'meta' | 'files' | 'symbols' | 'graph' | 'git' | 'commands' | 'pending'

/** Everything the router / MCP server needs, loaded in memory. */
export interface LoadedIndex {
  meta: IndexMeta
  files: FilesShard
  symbols: SymbolsShard
  graph: GraphShard
  git: GitShard
  commands: CommandsShard
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

export interface SessionState {
  /** repo-relative path -> read count (LRU-capped at 500 entries) */
  reads: Record<string, number>
  edits: string[]
  /** files whose "read the tests" nudge already fired */
  testsReminded: string[]
  firstPrompt?: string
  updatedAt: number
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
