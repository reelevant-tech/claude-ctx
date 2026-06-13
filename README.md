# claude-ctx

A global, repo-agnostic **smart context + autonomous prompt-injection layer for Claude Code**. It builds a compact repository intelligence index (project type, packages, symbols, import/dependency graph, tests, git signals, risk classification, commands) and uses it to make Claude Code behave more like Cursor: it injects the right context at the right moment, routes a free-text task to the files that matter, and steers away from broad greps, repeated reads, and dangerous commands — without you typing anything.

Works on Node.js / TypeScript and Rust repos (and degrades gracefully elsewhere). Deterministic static analysis only — no embeddings, no network calls, no LLM in the loop.

## How it works

```
Claude Code ──hooks──▶  ctx-hook (slim, ~40ms cold start, no parser)
            ──MCP───▶  ctx-mcp  (12 query tools)
                          │
                  ┌───────▼────────┐
                  │  ~/.claude-ctx │  per-repo sharded JSON index + session memory
                  └────────────────┘
```

- **SessionStart hook** ensures the index is fresh (incremental, or background build for huge repos) and injects a compact repo overview + coding rules + last-session recap.
- **UserPromptSubmit hook** routes your prompt to a token-budgeted *context pack* — the likely-relevant files, why each matters, key symbols, related tests, dependency links — and injects it before Claude starts working. Conversational prompts ("thanks", "yes") are skipped.
- **PreToolUse hooks** warn (advisory by default) on broad `grep -r`, reads of generated/huge files, edits to generated/infra/secret files, and dangerous shell commands (`rm -rf /`, force-push to main, `cat .env`, env exfiltration). Editing a file with unread tests nudges you to check them.
- **PostToolUse / Stop hooks** record session memory (files read/edited, commands run, decisions) and distill it for the next session.
- **MCP tools** let Claude pull context on demand instead of grepping.

Everything **fails open**: any error in the layer prints `{}` and exits 0, so it can never break a Claude Code session.

## Install

```bash
npm install
npm run build
node dist/cli.cjs install      # merges hooks into ~/.claude/settings.json (backed up first)
                               # + registers the `ctx` MCP server at user scope
node dist/cli.cjs doctor       # verify
```

Then open Claude Code in any repo — context is injected automatically. The first session indexes the repo (background for large repos). `node dist/cli.cjs uninstall` reverses everything (`--purge` also deletes indexed data); your original `settings.json` is restored byte-for-byte.

The installed bundles live in `~/.claude-ctx/bin/` (stable path, survives nvm node upgrades via the `ctx-hook` wrapper).

## CLI

Global flags: `--repo <path>` (default cwd, resolved to the git root), `--json`.

| Command | What it does |
|---|---|
| `ctx index [--full]` | index the current git repo (git top-level, not cwd) |
| `ctx index --all` | discover & index every git repo under the cwd |
| `ctx index --workspace <p>` | discover & index every git repo under `<p>` |
| `ctx repos` | list indexed repos (repoId, root, branches, current) |
| `ctx branches --repo <name\|id>` | list indexed branches for a repo |
| `ctx overview` | project type, packages, entrypoints, commands, tree |
| `ctx tree [--dir d]` | compact repo tree |
| `ctx pack "<task>" [--budget N]` | context pack for a task |
| `ctx symbols <q> [--kind --exported --limit]` | search symbols |
| `ctx related <path>` | imports / importers / co-changed / tests / siblings |
| `ctx deps <from> [to]` | dependency trace or fan-in/out |
| `ctx symbol_tree <file>` | nested symbol tree (AST) |
| `ctx calls <file>` | intra-file call expressions (best-effort) |
| `ctx references <symbol>` | name-based call sites of a symbol (best-effort) |
| `ctx tests <path>` | tests covering a file + how to run them |
| `ctx recent [--days --limit]` | recently changed files |
| `ctx vectors ["<query>"]` | semantic index stats, or nearest symbol chunks |
| `ctx eval <queries.json>` | benchmark retrieval: lexical vs hybrid vs vector, hit@k |
| `ctx risky <path>` | risk classification for a path |
| `ctx commands` | detected project commands |
| `ctx summary` | session memory summary |
| `ctx init [--rules]` | write a managed block into the repo's `CLAUDE.md` |
| `ctx embed-setup` | enable local offline semantic search (installs the model) |
| `ctx install / uninstall / doctor` | manage the global integration |

## MCP tools (`mcp__ctx__*`)

`repo_overview` · `repo_tree` · `context_pack` · `symbol_search` · `related_files` · `dep_trace` · `symbol_tree` · `calls` · `references` · `find_tests` · `recent_changes` · `risk_check` · `session_summary` · `session_note` · `index_refresh`. Every result is token-capped and never throws.

## AST / symbol trees & calls (tree-sitter)

Beyond the flat symbol list, the index builds a **nested symbol tree** per file (module → impl/class → methods) and best-effort **intra-file call expressions**:

- **TypeScript/JS** via the TypeScript compiler AST; **Rust** via tree-sitter (web-tree-sitter, WASM grammars shipped next to the bundle — no native deps). Rust tree-sitter replaces the regex parser when available and falls back to it otherwise.
- `ctx symbol_tree <file>` / `mcp__ctx__symbol_tree` — the nested tree with line spans and visibility.
- `ctx calls <file>` / `mcp__ctx__calls` — call expressions grouped by their enclosing function (best-effort).
- `ctx references <symbol>` / `mcp__ctx__references` — name-based call sites across files (best-effort; verify before relying on it — no overload/shadowing resolution).

This is deliberately **not** a global call graph: cross-file call resolution in TS/Rust gets wrong/noisy fast, so references stays name-based and clearly labelled best-effort.

## Hybrid semantic retrieval (local, offline)

By default the router is lexical + structural (symbols, paths, import graph, git signals). You can additionally enable a **local embeddings layer** for Cursor-style semantic retrieval — finding files by meaning even when they share no words with your task (e.g. "remember what I worked on" → the session-memory code, "stop the AI from wiping files" → the bash guard).

```bash
node dist/cli.cjs embed-setup        # installs a small model (transformers.js, WASM — no native deps)
                                     # into ~/.claude-ctx, then embeds the repo. ~50MB, one-time download.
```

After that it's **fully offline**. `ctx pack` and `mcp__ctx__context_pack` fuse a query-relative cosine score with the lexical/structural score; `ctx index` keeps the vectors fresh. It fails open — if the model isn't installed, everything falls back to pure lexical. The hook hot-path stays lexical-only (~40ms, no model load); semantic runs in the long-lived MCP server (warm model) and the CLI. Tune via `embeddings` in config; `--no-embed` forces lexical for a single `ctx pack`/`ctx index`.

Default model: `Xenova/all-MiniLM-L6-v2` (384-dim, quantized). The model's absolute cosines are compressed, so fusion is query-relative (normalized against the query's own max/mean), not threshold-based.

**Chunking is symbol-level.** Each file yields one file-level chunk plus one chunk per AST symbol (function/method/class/impl/struct/…); the embedded text is `path-words + parent chain + kind/name + the symbol's source span`. Retrieval scores every chunk and aggregates to a per-file max, surfacing the winning symbol (`semantically similar (via createInvoice)`). Generated/vendor/secret/asset files are excluded. The vectors shard records `{model, dim, createdAt, headCommit, hashes, entries[]}`; re-embedding is **incremental by content hash** (only changed files), and retrieval **refuses to compare across a different model/dim** (falls back to lexical). Inspect with `ctx vectors` (stats) or `ctx vectors "<query>"` (nearest chunks).

## Branch-keyed, multi-repo indexing

Indexing is **per-repo and per-branch**. `ctx index` always resolves the **git top-level** (`git rev-parse --show-toplevel`) — the cwd or a parent workspace folder is never treated as the repo root. From a folder containing many repos, `ctx index --all` (or `--workspace <path>`) discovers each git repo (a dir with a `.git` dir/file), resolves each one's own root, and indexes them independently; nested repos/submodules are treated as separate repos, and `node_modules`/`target`/`dist`/`.claude-ctx`/vendor/cache dirs are skipped.

Storage:
```
~/.claude-ctx/repos/<repoId>/
  repo.json                      # RepoIdentity: repoId, repoName, repoRoot, remoteUrl
  branches/<branchKey>/index/    # files/symbols/symtree/calls/graph/git/commands/vectors/meta.json
```
- `repoId` = hash of the realpath repo root (stable, collision-resistant, never workspace-derived).
- `branchKey` = sanitized branch name + short hash (`feature-auth-9f23ab`); detached HEAD → `detached-<short>`; unknown → `unknown`. Raw branch names (which may contain `/`, spaces, unicode) are never used as path segments. Resolved from `.git/HEAD` with **file reads only** (no subprocess — safe on the hook hot path).
- Switching branches uses a different index dir; the original branch's index is preserved.
- Sessions/memory stay repo-level (not branch-keyed).

Every structural + vector shard records `RepoIdentity` + `GitIdentity` (`branch, branchKey, headCommit, dirty, indexedAt`). A **dirty worktree still indexes and queries** — freshness is decided by file/chunk hash, not the dirty flag. Semantic search refuses to run (falls back to lexical, with a `CTX_DEBUG` warning) on any mismatch of repoId / branchKey / model / dim / schema. Old (pre-branch) indexes are ignored and rebuilt, never silently compared.

## Configuration

Defaults live in code; override globally in `~/.claude-ctx/config.json` and per-repo in `<repo>/.claude-context/config.json` (deep-merged). Notable keys:

```jsonc
{
  "packBudgetTokens": 1500,
  "overviewBudgetTokens": 700,
  "inject": { "sessionStart": true, "userPromptSubmit": true },
  "guard": { "bash": "warn", "edits": "warn", "reads": "warn" }, // warn | enforce | off
  "riskyGlobs": [], "secretGlobs": [], "exclude": [],
  "maxFileSizeKb": 512, "maxFiles": 20000, "bgIndexThresholdFiles": 2000,
  "embeddings": { "enabled": true, "model": "Xenova/all-MiniLM-L6-v2", "weight": 0.5 }
}
```

Guards are **warn-only by default** — they inject advisory context but never block. Set `guard.bash`/`guard.edits` to `"enforce"` to have severe commands denied and destructive ones prompted.

## Safety

- Secret files (`.env*`, `*.pem`, `*.key`, `credentials*`, …) are never read — only their paths are recorded.
- Every emitted excerpt passes a redaction pass (AWS/GitHub/OpenAI/Slack keys, JWTs, PEM blocks, high-entropy strings).
- `.gitignore` is respected (the index enumerates via `git ls-files`).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (328 tests)
npm run build       # esbuild -> dist/{cli,hook,mcp}.cjs; the hook bundle is
                    # guarded to exclude the TypeScript parser and stay <500KB
```

Source is TypeScript; three CJS bundles are emitted. The hook hot-path bundle must never import the `typescript` package (build fails otherwise) so cold start stays ~40ms.
