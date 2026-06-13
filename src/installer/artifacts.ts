import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../core/paths'

// Reference copy lives at assets/ctx-hook.sh; embedded here so the installed
// bundle has no asset-path resolution problem.
const CTX_HOOK_SH = `#!/bin/sh
# claude-ctx hook wrapper — resolves node, fails open (never breaks a Claude session)
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ] && [ -f "$DIR/../node-path" ]; then NODE="$(head -n1 "$DIR/../node-path")"; [ -x "$NODE" ] || NODE=""; fi
for CAND in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$CAND" ] && NODE="$CAND"; done
if [ -z "$NODE" ]; then echo '{}'; exit 0; fi
if [ "$1" = "mcp" ]; then exec "$NODE" "$DIR/mcp.cjs"; fi
exec "$NODE" "$DIR/hook.cjs" "$@"
`

const CTX_CLI_SH = `#!/bin/sh
# claude-ctx CLI wrapper
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node 2>/dev/null)"
if [ -z "$NODE" ] && [ -f "$DIR/../node-path" ]; then NODE="$(head -n1 "$DIR/../node-path")"; [ -x "$NODE" ] || NODE=""; fi
for CAND in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$CAND" ] && NODE="$CAND"; done
if [ -z "$NODE" ]; then echo 'ctx: node not found' >&2; exit 127; fi
exec "$NODE" "$DIR/cli.cjs" "$@"
`

export function installArtifacts(distDir: string): { binDir: string } {
  const binDir = join(dataDir(), 'bin')
  mkdirSync(binDir, { recursive: true })
  for (const f of ['cli.cjs', 'hook.cjs', 'mcp.cjs']) {
    const src = join(distDir, f)
    if (existsSync(src)) copyFileSync(src, join(binDir, f))
  }
  // tree-sitter WASM grammars (loaded by the AST layer relative to the bundle)
  const grammarsSrc = join(distDir, 'grammars')
  if (existsSync(grammarsSrc)) {
    const grammarsDst = join(binDir, 'grammars')
    mkdirSync(grammarsDst, { recursive: true })
    for (const f of readdirSync(grammarsSrc)) {
      if (f.endsWith('.wasm')) copyFileSync(join(grammarsSrc, f), join(grammarsDst, f))
    }
  }
  const wrapper = join(binDir, 'ctx-hook')
  writeFileSync(wrapper, CTX_HOOK_SH)
  chmodSync(wrapper, 0o755)
  const cli = join(binDir, 'ctx')
  writeFileSync(cli, CTX_CLI_SH)
  chmodSync(cli, 0o755)
  writeFileSync(join(dataDir(), 'node-path'), process.execPath + '\n')
  return { binDir }
}
