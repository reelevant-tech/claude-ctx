# Benchmark and positioning — claude-ctx

This document compares **claude-ctx** (package `claude-ctx`, CLI `ctx`) to nearby open-source projects on the same problem: giving a coding agent (especially **Claude Code**) better repo understanding without loading everything into context.

Goal: stay **factual**. Numbers cited for claude-ctx come from this repo's code and tests; numbers for other projects come from their public README / docs (June 2026). No cross-repo benchmark was run here against third-party codebases.

---

## What claude-ctx does (one sentence)

A **global, repo-agnostic layer** that combines:

1. a **deterministic index** (static analysis, no LLM in the loop);
2. a **context router** (token-budgeted pack per task);
3. **Claude Code hooks** that inject that context and apply guards;
4. an **MCP server** for on-demand queries;
5. **session memory** distilled across sessions.

It is not "just a semantic search MCP". The main difference vs most comparable repos is **autonomous injection** (Cursor-style) rather than leaving it entirely to the agent to decide when to call a tool.

---

## Comparable projects (open source)

| Project | Stars (order of magnitude) | Primary focus | Languages (depth) | Storage | Embeddings |
|--------|------------------------------|---------------|-------------------|---------|------------|
| [zilliztech/claude-context](https://github.com/zilliztech/claude-context) | ~12k | Hybrid BM25 + vector search for Claude Code | Multi (AST chunking + fallback) | Milvus / Zilliz Cloud | OpenAI, Voyage, Ollama, Gemini (often cloud) |
| [oraios/serena](https://github.com/oraios/serena) | ~25k | IDE tools (LSP): symbols, refs, rename, edit | 30+ via LSP | Local project + LSP | No (symbolic / LSP) |
| [amacsmith/codebase-memory-mcp](https://github.com/amacsmith/codebase-memory-mcp) | small | Knowledge graph + structural queries | 155 (tree-sitter) | Persistent graph | Nomic bundled in binary |
| [g-tiwari/mcp-codebase-intelligence](https://github.com/g-tiwari/mcp-codebase-intelligence) | small | Semantic SQLite graph + 18 MCP tools | 8 (tree-sitter) | SQLite WAL | Not documented as primary layer |
| [groxaxo/mcp-code-indexer](https://github.com/groxaxo/mcp-code-indexer) | small | Local hybrid index + callgraph | Python AST in depth | Qdrant + SQLite | Local ONNX, optional reranker |
| [LakyFx/CogniLayer](https://github.com/LakyFx/CogniLayer) | ~30 | Persistent memory + graph + subagent compression | Multi (tree-sitter) | SQLite + sqlite-vec | Local fastembed |
| [websines/codegraph-mcp](https://github.com/websines/codegraph-mcp) | ~6 | Graph + session memory (Rust) | 5 (tree-sitter) | libSQL / SQLite | No |

claude-ctx sits at the intersection of **Claude Code + proactive context + local index**, with AST depth for TS/JS, Rust, and Python (tree-sitter + fallback) plus integrated hooks and guards.

---

## Comparison by axis

### 1. Claude Code integration mode

| | claude-ctx | claude-context | Serena | codebase-memory-mcp |
|---|:---:|:---:|:---:|:---:|
| MCP | yes (19 tools) | yes (4 tools) | yes (~20+ tools) | yes (~14 tools) |
| SessionStart / UserPromptSubmit hooks | **yes** | no | no (client config) | no |
| PreToolUse guards (bash, grep, read, edit) | **yes** | no | no | no |
| PostToolUse / Stop memory | **yes** | no | partial (memory tools) | ADR / traces |
| Fail-open (never breaks the session) | **yes** (`{}`, exit 0) | depends on MCP error | depends | depends |

**Key difference**: claude-ctx pushes context **before** the agent reads or greps — `UserPromptSubmit` injects a ranked pack with no agent action. "Search-only" MCPs require the model to decide to call `search_code` / `semantic_query`, which costs turns and context.

### 2. Code analysis quality

| Capability | claude-ctx | Serena | codebase-memory-mcp | claude-context |
|------------|------------|--------|---------------------|----------------|
| Symbol resolution | TS via compiler API; Rust + **Python** via tree-sitter WASM (+ regex fallback each) | **LSP** (type-aware refs) | tree-sitter + hybrid resolution Go/C/C++ | AST chunking |
| One-call symbol trace (`trace_symbol`) | **yes** (def + refs + callees + imports) | partial (tool chain) | partial | no |
| Symbol body in one call (`symbol_body`) | **yes** | no | no | no |
| Cross-file flow (`call_chain`) | **yes** (best-effort, labelled edges) | **yes** (via LSP) | **yes** (BFS, Cypher-like) | no |
| Field data-flow (`field_refs`) | **yes** (TS-typed when resolvable) | partial | not documented | no |
| Global call graph | **no** (by design) | **yes** (via LSP) | **yes** (BFS, Cypher-like) | no |
| Cross-file `references` | typed-or-name-based (TS) | **precise** (LSP) | yes (graph) | semantic search |
| Symbolic edit / rename | no | **yes** | no | no |
| Test detection + run command | **yes** | partial | not documented | no |
| Risk classification (generated, infra, secret) | **yes** | no | blast radius | extension filters |
| Languages beyond TS/Rust/Python | lexical only | **30+** | **155** | broad |

**Honesty**: on **structural precision** (who calls whom, safe rename), Serena and codebase-memory-mcp are ahead. claude-ctx explicitly does not claim a reliable global call graph in TS/Rust/Python — `references` and `call_chain` are labelled best-effort in the README. The newer `trace_symbol` / `symbol_body` / `field_refs` tools reduce Read/grep loops but do not replace LSP-grade rename.

### 2b. Symbol tracing and data-flow (newer MCP surface)

Beyond flat `symbol_search` + `references`, claude-ctx now exposes four **one-call** tools aimed at agent workflows (also available as `ctx trace`, `ctx body`, `ctx call-chain`, `ctx field-refs`):

| Tool | What it answers | vs alternatives |
|------|-----------------|-----------------|
| `trace_symbol` | Definition + tagged refs (`def`/`call`/`use`) + callees + import paths + related files | Replaces chaining `symbol_search` → `references` → `related_files` |
| `symbol_body` | Full source body of a symbol (redacted, capped) | Avoids repeated `Read` loops on large files |
| `call_chain` | Best-effort cross-file execution flow; edges labelled `same-file` / `import` / `heuristic` / `external` | Not a precise global call graph; honest about resolution method |
| `field_refs` | Read / write / destructure sites of `obj.field` (TS type-aware when resolvable) | Answers "where is this **value** produced/consumed", not symbol-by-name |

Most comparable MCPs in the panel above lack this integrated trace stack; Serena covers overlapping ground via LSP but requires the agent to orchestrate multiple tool calls.

### 3. Retrieval (lexical / hybrid / semantic)

| | claude-ctx | claude-context | mcp-code-indexer | CogniLayer |
|---|------------|----------------|------------------|------------|
| Lexical | **BM25F multi-field** (basename, exported symbols, path segments, headings) | BM25 | BM25 | FTS5 |
| Semantic | optional, **100% local** (transformers.js WASM, MiniLM default) | hybrid, often **API + Milvus** | ONNX + Qdrant | fastembed |
| Fusion | lexical + structure (recency, centrality, tests, git) + query-relative cosine | BM25 + dense | hybrid + cross-encoder reranker | hybrid FTS + vectors |
| Offline query expansion | **yes** (FR→EN, synonyms, per-repo `tokenAliases`) | not documented | not documented | not documented |
| Built-in eval harness | **`ctx eval`** (hit@k, MRR, lexical vs hybrid vs vector) | no | no | no |
| Scale (millions of LOC) | local JSON shards; no distributed vectordb | **built for** (Zilliz) | local Qdrant | SQLite |

**Key difference**: claude-ctx optimizes for **zero infra, zero API key, zero Docker** on the default path. claude-context scales better on very large monorepos if you accept Milvus/Zilliz and often a cloud embedding key.

### 4. Operational footprint

| | claude-ctx | Typical alternatives |
|---|------------|----------------------|
| Claude Code install | `ctx install` (hooks + MCP + embed runtime) | manual `claude mcp add ...` per tool |
| Multi-repo index | `~/.claude-ctx/repos/<repoId>/`; `ctx index --all` | often one repo = one MCP config |
| Branch-keyed index | **yes** (separate `branchKey`) | rare (git-aware in mcp-code-indexer) |
| Incremental re-index | file hash + embedding chunk hash | Merkle tree (claude-context) or hash (others) |
| Hook hot path | dedicated bundle **without** TS parser (~40ms claimed) | N/A (no hooks) |
| Automated tests | 426 tests (vitest, this repo) | varies (Serena: large Python suite) |

### 5. Safety and guardrails

claude-ctx is one of the few in this panel that combines:

- secret redaction in injected excerpts;
- secret paths never read (only the path is indexed);
- bash guards (`rm -rf /`, force-push to main, `cat .env`, env exfiltration);
- broad-grep guards, reads of huge / generated files;
- nudge when editing a file without reading its tests;
- `warn` mode by default, optional `enforce`.

Search MCPs generally cover **none** of this — it is not their role.

---

## Internal retrieval benchmark (claude-ctx)

Numbers documented in the README, on a **proprietary 18-query benchmark** ("reelevant" project, not published in this repo). Treat as an internal indicator, not a universal score.

| Configuration | hit@3 | MRR | Notes |
|---------------|-------|-----|-------|
| Lexical only (BM25F + structure) | not published in detail | — | baseline |
| Hybrid + FR/EN expansion + aliases | **17/18** | **0.833** | FR MRR 0.667 → 0.800 |
| Hybrid + 1 repo alias (`tokenAliases`) | **18/18** | **0.889** | zero extra embedding cost |
| multilingual-e5-small (embeddings) | regression | **0.792** | 2 regressions vs expansion alone |
| jina-embeddings-v2-base-code | < MiniLM hit@8 | — | ~5× embed time, 2× storage |

**Factual lessons** (on this benchmark only):

1. **Deterministic query expansion** had more impact than switching embedding models.
2. A heavier "code" model did **not** beat MiniLM on this 18-query set.
3. The `ctx eval <queries.json>` harness lets you reproduce these metrics on your own repo — that is the honest way to compare.

We did **not** run `ctx eval` against claude-context or Serena on the same query set: their APIs and result granularity (chunks vs symbols vs files) are not directly comparable without normalization.

---

## Quick agent task benchmark (manual, June 2026)

Six **complex, multi-file** questions on two proprietary Reelevant codebases (datasource pipeline + workflow engine). Each question was run once with claude-ctx installed (hooks + MCP) vs once without. Wall-clock time to a satisfactory answer, measured manually.

### Queries

**Datasource repo**

| # | Question (abbrev.) |
|---|------------------|
| Q1 | KEEP_PREVIOUS_DATA lifecycle: SCHEDULED→LIVE while a prior `live_*` Bull job is still active — job IDs/order, Pinot physical/logical table mutations, time boundaries, guard rails, implementing files/functions, and matching e2e test assertions |
| Q2 | Guard rails preventing a LIVE worker job from switching the logical Pinot table to a non-queryable physical table; rollback on crash after switch; e2e coverage |
| Q3 | Query-service routing (Pinot vs Starrocks vs dual); dual-write whitelist at ingestion; failure modes when one backend succeeds and the other fails (query + worker) |

**Workflow repo**

| # | Question (abbrev.) |
|---|------------------|
| Q4 | Full `AutomaticIndexResolving` lifecycle: SDK declaration → publish-time analyze → Redis cache → engine runtime; required vs stripped `WorkflowAnalyze` fields; fallback when `entrypointsPerDataNodeId` misses the current entrypoint; difference from `AutomaticMapping` |
| Q5 | Exact `publish()` order: io-ts validation, executor hooks, analyze, complexity score; which nodes trigger hooks and `prioritySorter` order |
| Q6 | Multi-ids dependency (`ids: [nodeA, nodeB]`): how the engine picks the data node; which `contexts.internal` field tracks the executed branch |

### Results

| Query | With claude-ctx | Without |
|-------|----------------:|--------:|
| Q1 | 10s | 180s |
| Q2 | 10s | 120s |
| Q3 | 20s | 70s |
| Q4 | 40s | 60s |
| Q5 | 5s | 100s |
| Q6 | 20s | 40s |
| **Total** | **105s** | **570s** |

**~5.4× faster** on this ad-hoc set. Gains are largest on infra-heavy questions (Q1–Q3) where proactive context + `trace_symbol` / `call_chain` / `field_refs` avoid broad greps and repeated reads. Q4 is closer — both runs needed deep tracing; Q5 benefits most from injected file/symbol context (5s vs 100s).

**Limits**: n=1 per condition, subjective "satisfactory answer", proprietary repos not reproducible here. Treat as anecdotal; run your own queries with and without `ctx install`.

---

## Where claude-ctx is ahead (factual)

1. **Cursor-style autonomous injection** via hooks — not just opt-in MCP tools.
2. **Full stack**: index + router + MCP + memory + guards in one `ctx install`.
3. **Offline by default**: no Milvus, no OpenAI key required; optional WASM embeddings.
4. **Systematic fail-open** on the hook hot path.
5. **Branch-keyed** and global multi-repo index under `~/.claude-ctx`.
6. **BM25F + structural signals + git** without depending on a vectordb.
7. **Offline multilingual query expansion** (FR→EN) — rare elsewhere.
8. **`ctx eval`** to benchmark lexical / hybrid / vector on your own queries.
9. **Hook / MCP / CLI split** (3 esbuild bundles) to keep hooks fast.
10. **One-call symbol tracing stack** (`trace_symbol`, `symbol_body`, `call_chain`, `field_refs`) — fewer agent turns than chaining search + read + grep.
11. **Python AST** via tree-sitter (symbol tree, calls, imports) with regex fallback — third rich-parse language alongside TS and Rust.

---

## Where claude-ctx is behind (factual)

1. **Language coverage**: rich AST for TS/JS, Rust, and Python (tree-sitter + fallback); everything else is lexical. Serena (LSP) and codebase-memory-mcp (155 languages) still dominate on breadth.
2. **Reference precision**: no LSP; `references` is best-effort by name. Serena clearly wins on "find all references" and rename.
3. **No symbolic editing tools** (rename, replace body, insert) — Serena is an "IDE for agents".
4. **Scale**: no distributed vectordb; claude-context + Zilliz explicitly targets millions of LOC.
5. **Community / maturity**: young project (v0.1.0) vs Serena (~25k stars) and claude-context (~12k stars).
6. **No IDE extension** (VS Code) — claude-context has one.
7. **No queryable knowledge graph** (Cypher, rich blast radius) — codebase-memory-mcp and mcp-codebase-intelligence go further.
8. **No cross-encoder reranker** — mcp-code-indexer may be more precise in tight top-k.
9. **Embeddings**: general-purpose MiniLM by default; no code embedding bundled in the binary like Nomic in codebase-memory-mcp.
10. **MCP alone**: 19 tools, but the agent can still ignore injected context — hooks reduce the problem, they do not eliminate it.
11. **`field_refs` precision**: TS-only when the type system resolves; Python/Rust field tracking is name-based.

---

## Decision matrix (when to use what)

| Need | Honest recommendation |
|------|----------------------|
| Claude Code gets context **without you asking** | **claude-ctx** |
| Reliable multi-language symbolic rename / edit | **Serena** (LSP) |
| Semantic search on a huge monorepo with vector infra | **claude-context** (+ Milvus/Zilliz) |
| Call graph / impact analysis / graph queries | **codebase-memory-mcp** or **mcp-codebase-intelligence** |
| Heavy Python + callgraph + local Qdrant | **mcp-code-indexer** |
| Long-lived memory + subagent compression | **CogniLayer** or **codegraph-mcp** |
| Zero deps, single binary, 100+ languages | **codebase-memory-mcp** |
| Fully offline, TS/Rust/Python, bash guards, FR+EN | **claude-ctx** |

These tools are **complementary**, not mutually exclusive. claude-ctx + Serena is a plausible combo: proactive injection + LSP precision when the agent edits.

---

## Methodology and limits of this document

- **No end-to-end agent benchmark** (turns to resolution, tokens consumed, task success rate) on third-party projects — only internal retrieval + a small manual agent task set (see above).
- **No latency measurement** on third-party projects — only the ~40ms hook cold-start target declared in this repo.
- **GitHub stars**: popularity signal, not quality.
- hit@k / MRR numbers come from a **single reference repo** not included here; your mileage will vary.
- Code state: v0.1.0, 426 passing tests, 19 MCP tools, 8 hooks. Rich AST: TS/JS, Rust, Python.

To contribute a reproducible benchmark: add a `queries.json` file (`ctx eval` format) and document hit@k / MRR per mode in a PR.

---

## One-line summary

**claude-ctx** does not try to be the best semantic search engine or the best LSP — it aims to be the **local orchestration layer** that makes Claude Code behave a bit more like Cursor: context injected at the right moment, deterministic index, guards, memory, no mandatory cloud. On symbolic precision and scale, the current open-source leaders remain Serena (LSP) and claude-context (vectors + Milvus).
