# bench/ — does claude-ctx actually save tokens?

`ctx eval` measures retrieval *ranking* (hit@k / MRR). It does **not** answer the
product question: over a real session, does claude-ctx reduce total tokens at equal
task quality? This harness measures that with an A/B over a fixed corpus.

## What it measures

The hooks log a per-session JSONL audit trail with the token cost of every
`Read` / `Bash` / `mcp__ctx__*` result and every injection decision. `ctx
bench-session` aggregates it; `run-ab.sh` runs the corpus under two arms and diffs:

```
net_saved = (read + bash_output)_baseline
          − (read + bash_output + tokens_injected + mcp_result)_treatment
```

- **baseline** = `inject.shadow=true` (observe-only: claude-ctx records but injects/steers
  nothing — Claude behaves as if it weren't installed).
- **treatment** = `inject.shadow=false` (full claude-ctx).

`net_saved > 0` ⇒ claude-ctx is cheaper over the corpus.

## Run it

Every task is a **real headless agent session billed to your account**, so the default
driver is tuned for cost: **Haiku** model + a **hard per-task dollar cap**. The script
prints the billed-session count and worst-case cost before it starts.

```bash
npm run build && cp dist/*.cjs ~/.claude-ctx/bin/   # build AND reinstall (see note)

# smoke first (3 tasks, 1 run/arm) — confirms the loop works, costs pennies on Haiku:
bench/run-ab.sh bench/corpus-smoke.json 1

# the real run (16 tasks × 3 runs/arm), still on Haiku by default:
bench/run-ab.sh bench/corpus.json
```

**Cost knobs** (the default is already the cheap path — only touch these to change it):

| Env var | Default | Effect |
|---|---|---|
| `CTX_BENCH_MODEL` | `haiku` | model alias (`haiku`/`sonnet`/`opus`) or full id |
| `CTX_BENCH_BUDGET_USD` | `0.50` | hard `--max-budget-usd` ceiling **per task** — claude aborts the task at the cap |
| `CTX_BENCH_DRIVER` | _(unset)_ | overrides the whole command, ignoring the two knobs above |

Worst-case spend = `tasks × runs × 2 arms × CTX_BENCH_BUDGET_USD`; real spend is far lower
because few tasks hit the cap. To bench what a *real* (Opus/Sonnet) session would do, set
`CTX_BENCH_MODEL=sonnet` — more faithful, more expensive. The routing effect the harness
measures (Read/Bash/MCP tokens from the session logs) is logged the same way on any model.

**Why `--dangerously-skip-permissions` (baked into the default driver)?** The corpus tasks
need read-only tools (`Read`/`Grep`/`mcp__ctx__*`). In headless mode *without* it, `claude
-p` blocks waiting for tool approval and the task hangs. The flag auto-allows tools — fine
for a read-only corpus, but run on a throwaway checkout to be safe.

Requires the `claude` CLI on PATH. The script snapshots your global
`~/.claude-ctx/config.json`, toggles `inject.shadow` per arm, archives each arm's new
session logs to `bench/runs/<arm>/`, restores your config on exit, and prints the diff.
Inspect a single arm any time with `ctx bench-session --dir bench/runs/live`.

> **Reinstall after every rebuild.** `claude -p` runs the *installed* hook at
> `~/.claude-ctx/bin/hook.cjs`, **not** `dist/`. If you `npm run build` but forget to
> copy the bundles over, the run silently uses the old hook — no token logging, no pack
> events, `net_saved=0`. The harness now preflight-checks this and aborts with a hint.

### Troubleshooting

- **All token columns are 0 / `net_saved=0` / `packs=0`.** Stale install — the live hook
  predates the instrumentation. `npm run build && cp dist/*.cjs ~/.claude-ctx/bin/`, then
  re-run. (The preflight check catches this now.)
- **Hangs on the first task, no progress.** Almost always the permission wall above —
  add `--dangerously-skip-permissions` via `CTX_BENCH_DRIVER`. (The harness already
  redirects the driver's stdin from `/dev/null`; without that, `claude` would also hang
  reading the loop's input pipe.)
- **Looks frozen between progress lines.** Normal — each `[arm rN] taskid` line is a full
  headless agent session (~30 s–2 min). Driver output is silenced; watch progress with
  `watch -n5 'ls -lt ~/.claude-ctx/repos/*/sessions/*.jsonl | head'`.
- **Want to see what Claude does?** Drop the `>/dev/null 2>&1` on the driver line in
  `run-ab.sh` temporarily.

> **Run on a throwaway checkout.** The corpus is read-only investigation tasks and a
> "read-only, do not modify" instruction is passed via the **system** prompt (kept out
> of the scored user message on purpose), but a headless agent can still wander —
> don't point it at a tree you care about.

## Honest limits (state these with any number you publish)

1. **Non-determinism.** `claude -p` won't read the same files twice. Use ≥3 runs/arm
   (the default) and treat the mean as indicative, not exact.
2. **Baseline isn't *zero* claude-ctx.** Shadow mode silences the hooks, but the
   `mcp__ctx__*` tools stay reachable and any `ctx init` block in `CLAUDE.md` stays on
   disk. For a strict vanilla baseline also remove the MCP server and that block.
3. **Quality isn't measured.** `net_saved` counts tokens, not task success — a cheaper
   run that answers worse is not a win. Pair each task with a pass/fail judgment.
4. **Token sizes are estimates** (~4 chars/token), good for relative deltas, not billing.

Until this A/B is run and reported with its corpus, the defensible public claim is
"routes Claude to likely-relevant files/symbols/tests instead of exploratory greps",
**not** a "saves X%" figure.

## Customize the corpus

`corpus.json` is `[{ "id": "...", "prompt": "..." }]`. Keep prompts **read-only**
(investigation/QA), not edit tasks, so runs don't mutate the repo. Tasks should reflect
the exploration claude-ctx targets (find/trace/understand), where its routing helps most.
