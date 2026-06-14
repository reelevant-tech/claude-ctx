#!/usr/bin/env bash
#
# A/B token-cost harness for claude-ctx.
#
# Runs a read-only investigation corpus through headless Claude Code twice:
#   - arm "shadow"  (inject.shadow=true)  — observe-only baseline: claude-ctx
#                                            records token costs but injects/steers
#                                            nothing, so Claude behaves as if it
#                                            weren't installed.
#   - arm "live"    (inject.shadow=false) — full claude-ctx (injection + steering).
#
# It archives each arm's per-session logs and prints `ctx bench-session`'s diff
# (read/bash/MCP/injected tokens + net_saved). See bench/README.md for caveats.
#
# Usage:   bench/run-ab.sh <corpus.json> [runs-per-arm=3] [outdir=bench/runs]
# Driver:  override how one prompt is run via CTX_BENCH_DRIVER (default: "claude -p").
#
set -euo pipefail
shopt -s nullglob

CORPUS="${1:?usage: bench/run-ab.sh <corpus.json> [runs-per-arm=3] [outdir=bench/runs]}"
RUNS="${2:-3}"
OUT="${3:-bench/runs}"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CONFIG_DIR="${CLAUDE_CTX_HOME:-$HOME/.claude-ctx}"
CONFIG="$CONFIG_DIR/config.json"
CLI_JS="$REPO_ROOT/dist/cli.cjs"
PROMPT_PREFIX="Investigate this repository and answer in prose only. Do NOT edit, create, or delete any files, and do not run destructive commands. Question: "

# How to run one headless Claude Code prompt. Overridable for testing.
DRIVER="${CTX_BENCH_DRIVER:-claude -p}"
read -r -a DRIVER_ARR <<< "$DRIVER"

if [ ! -f "$CLI_JS" ]; then
  echo "Missing $CLI_JS — run 'npm run build' first." >&2
  exit 1
fi

# Preflight: the LIVE Claude Code hook (what `claude -p` runs) is the *installed*
# bundle, not dist/. If you rebuilt but didn't reinstall, the run silently uses the
# old hook — no token logging, no pack events, net_saved=0. Catch that here.
INSTALLED_HOOK="$CONFIG_DIR/bin/hook.cjs"
if [ ! -f "$INSTALLED_HOOK" ]; then
  echo "claude-ctx hook not installed at $INSTALLED_HOOK — run 'node dist/cli.cjs install' first." >&2
  exit 1
fi
if ! grep -q "confidenceGate" "$INSTALLED_HOOK"; then
  echo "Installed hook is STALE (missing the bench instrumentation)." >&2
  echo "Rebuild + reinstall first:  npm run build && cp dist/*.cjs \"$CONFIG_DIR/bin/\"" >&2
  exit 1
fi
if [ -z "${CTX_BENCH_DRIVER:-}" ] && ! command -v claude >/dev/null 2>&1; then
  echo "The 'claude' CLI is not on PATH. Install Claude Code, or set CTX_BENCH_DRIVER." >&2
  exit 1
fi

# --- preserve the user's global config; restore on any exit ------------------
BACKUP="$(mktemp)"
HAD_CONFIG=0
if [ -f "$CONFIG" ]; then cp "$CONFIG" "$BACKUP"; HAD_CONFIG=1; fi
restore() {
  if [ "$HAD_CONFIG" = 1 ]; then cp "$BACKUP" "$CONFIG"; else rm -f "$CONFIG"; fi
  rm -f "$BACKUP"
}
trap restore EXIT

# Set inject.shadow in the global config, preserving every other key.
set_shadow() { # $1 = true|false
  node -e '
    const fs = require("fs"), path = require("path");
    const p = process.argv[1], v = process.argv[2] === "true";
    let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    c.inject = Object.assign({}, c.inject, { shadow: v });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  ' "$CONFIG" "$1"
}

# Every session jsonl across all indexed repos, sorted (paths only).
snapshot() {
  local dirs=("$CONFIG_DIR"/repos/*/sessions)
  [ ${#dirs[@]} -eq 0 ] && return 0
  find "${dirs[@]}" -name '*.jsonl' 2>/dev/null | sort
}

run_arm() { # $1 = arm name, $2 = shadow value
  local arm="$1" shadow="$2"
  set_shadow "$shadow"
  local dest="$OUT/$arm"
  mkdir -p "$dest"
  echo ">>> arm=$arm  inject.shadow=$shadow  ($RUNS run(s))" >&2
  for r in $(seq 1 "$RUNS"); do
    local before after
    before="$(snapshot)"
    while IFS=$'\t' read -r id prompt; do
      [ -z "$prompt" ] && continue
      echo "    [$arm r$r] $id" >&2
      # </dev/null is critical: this loop's stdin is the corpus pipe; without it
      # `claude` would read/wait on that stream and hang on the first task.
      ( cd "$REPO_ROOT" && "${DRIVER_ARR[@]}" "$PROMPT_PREFIX$prompt" </dev/null ) >/dev/null 2>&1 \
        || echo "    (task $id failed; continuing)" >&2
    done < <(node -e '
      const fs = require("fs");
      for (const t of JSON.parse(fs.readFileSync(process.argv[1], "utf8")))
        process.stdout.write(String(t.id).replace(/\s+/g, "_") + "\t" + String(t.prompt).replace(/[\t\n]/g, " ") + "\n");
    ' "$CORPUS")
    after="$(snapshot)"
    # only sessions created during this run (new paths) belong to this arm
    comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | while read -r f; do
      [ -n "$f" ] && cp "$f" "$dest/run${r}_$(basename "$f")"
    done
  done
}

rm -rf "$OUT/shadow" "$OUT/live"
run_arm shadow true
run_arm live false

echo
echo "================= A/B result ================="
node "$CLI_JS" bench-session --baseline "$OUT/shadow" --treatment "$OUT/live"
