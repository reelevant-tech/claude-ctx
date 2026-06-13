#!/bin/sh
# claude-ctx hook wrapper — resolves node, fails open (never breaks a Claude session)
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ] && [ -f "$DIR/../node-path" ]; then NODE="$(head -n1 "$DIR/../node-path")"; [ -x "$NODE" ] || NODE=""; fi
for CAND in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$CAND" ] && NODE="$CAND"; done
if [ -z "$NODE" ]; then echo '{}'; exit 0; fi
if [ "$1" = "mcp" ]; then exec "$NODE" "$DIR/mcp.cjs"; fi
exec "$NODE" "$DIR/hook.cjs" "$@"
