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
}

const builds = [
  { entryPoints: ['src/bin/cli.ts'], outfile: 'dist/cli.js' },
  { entryPoints: ['src/bin/mcp.ts'], outfile: 'dist/mcp.js' },
  { entryPoints: ['src/bin/hook.ts'], outfile: 'dist/hook.js', metafile: true },
]

let hookMeta = null
for (const b of builds) {
  const result = await build({ ...common, ...b })
  if (b.outfile === 'dist/hook.js') hookMeta = result.metafile
}

// Hook bundle guard: the hook hot-path must never pull in the typescript parser
// (8MB, ~1s parse cost) and must stay under 500KB so cold-start stays <500ms.
const hookInputs = Object.keys(hookMeta.inputs)
const offenders = hookInputs.filter((p) => p.includes('node_modules/typescript'))
if (offenders.length > 0) {
  console.error('FATAL: dist/hook.js bundles the typescript package:', offenders.slice(0, 3))
  process.exit(1)
}
const hookSize = statSync('dist/hook.js').size
if (hookSize > 500 * 1024) {
  console.error(`FATAL: dist/hook.js is ${(hookSize / 1024).toFixed(0)}KB (limit 500KB)`)
  process.exit(1)
}
console.log(
  `build ok — cli.js ${(statSync('dist/cli.js').size / 1024 / 1024).toFixed(1)}MB, ` +
    `mcp.js ${(statSync('dist/mcp.js').size / 1024 / 1024).toFixed(1)}MB, ` +
    `hook.js ${(hookSize / 1024).toFixed(0)}KB`,
)
