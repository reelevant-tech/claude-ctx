#!/bin/sh
# claude-ctx CLI wrapper
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ] && [ -f "$DIR/../node-path" ]; then NODE="$(head -n1 "$DIR/../node-path")"; [ -x "$NODE" ] || NODE=""; fi
for CAND in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$CAND" ] && NODE="$CAND"; done
if [ -z "$NODE" ]; then echo 'ctx: node not found' >&2; exit 127; fi
exec "$NODE" "$DIR/cli.cjs" "$@"
