import { build } from 'esbuild'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Three self-contained CJS bundles:
//  - cli.cjs  : full CLI (embeds the `typescript` parser + web-tree-sitter)
//  - mcp.cjs  : MCP stdio server (embeds the parser, long-lived)
//  - hook.cjs : hook hot-path — MUST stay slim; NO typescript / embed / ast / tree-sitter
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

// Ship tree-sitter WASM grammars next to the bundles (the loader finds them in
// ./grammars relative to the running bundle).
mkdirSync('dist/grammars', { recursive: true })
const GRAMMARS = [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm', 'tree-sitter-rust.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
]
for (const [src, name] of GRAMMARS) {
  try {
    copyFileSync(src, join('dist/grammars', name))
  } catch (e) {
    console.error(`WARN: could not copy grammar ${src}: ${e.message}`)
  }
}

// Hook bundle guard: the hook hot-path must never pull in the typescript parser,
// the embeddings layer, or tree-sitter — and must stay under 500KB so cold-start
// stays <500ms.
const hookInputs = Object.keys(hookMeta.inputs)
const offenders = hookInputs.filter(
  (p) =>
    p.includes('node_modules/typescript') ||
    p.includes('src/core/embed/') ||
    p.includes('src/core/ast/') ||
    p.includes('web-tree-sitter'),
)
if (offenders.length > 0) {
  console.error('FATAL: dist/hook.cjs pulls in a forbidden module (typescript/embed/ast):', offenders.slice(0, 3))
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
