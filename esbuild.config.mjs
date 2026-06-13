import { build } from 'esbuild'
import { statSync } from 'node:fs'

// Three self-contained CJS bundles:
//  - cli.js  : full CLI (embeds the `typescript` parser)
//  - mcp.js  : MCP stdio server (embeds the parser, long-lived)
//  - hook.js : hook hot-path — MUST stay slim and MUST NOT bundle `typescript`
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' },
  // transformers.js (WASM + dynamic model loading) is loaded at runtime via
  // dynamic import, not bundled — resolved from project or ~/.claude-ctx node_modules.
  external: ['@huggingface/transformers'],
}

// .cjs extension so Node treats them as CommonJS regardless of package.json
// "type": "module" — and regardless of which dir they're copied into.
const builds = [
  { entryPoints: ['src/bin/cli.ts'], outfile: 'dist/cli.cjs' },
  { entryPoints: ['src/bin/mcp.ts'], outfile: 'dist/mcp.cjs' },
  { entryPoints: ['src/bin/hook.ts'], outfile: 'dist/hook.cjs', metafile: true },
]

let hookMeta = null
for (const b of builds) {
  const result = await build({ ...common, ...b })
  if (b.outfile === 'dist/hook.cjs') hookMeta = result.metafile
}

// Hook bundle guard: the hook hot-path must never pull in the typescript parser
// (8MB, ~1s parse cost) and must stay under 500KB so cold-start stays <500ms.
const hookInputs = Object.keys(hookMeta.inputs)
const offenders = hookInputs.filter(
  (p) => p.includes('node_modules/typescript') || p.includes('embed/'),
)
if (offenders.length > 0) {
  console.error('FATAL: dist/hook.cjs pulls in a forbidden module (typescript/embed):', offenders.slice(0, 3))
  process.exit(1)
}
const hookSize = statSync('dist/hook.cjs').size
if (hookSize > 500 * 1024) {
  console.error(`FATAL: dist/hook.cjs is ${(hookSize / 1024).toFixed(0)}KB (limit 500KB)`)
  process.exit(1)
}
console.log(
  `build ok — cli.cjs ${(statSync('dist/cli.cjs').size / 1024 / 1024).toFixed(1)}MB, ` +
    `mcp.cjs ${(statSync('dist/mcp.cjs').size / 1024 / 1024).toFixed(1)}MB, ` +
    `hook.cjs ${(hookSize / 1024).toFixed(0)}KB`,
)
