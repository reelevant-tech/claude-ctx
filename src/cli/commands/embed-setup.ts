import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../../core/config'
import { buildVectors } from '../../core/embed/build'
import { transformersAvailable } from '../../core/embed/embedder'
import { buildIndex } from '../../core/indexer/index'
import { dataDir } from '../../core/paths'
import { loadMeta } from '../../core/store/shards'
import { out, parseCommon } from '../shared'

const PKG = '@huggingface/transformers'

/** Resolvable from ~/.claude-ctx (where the installed bundles look), not just dev node_modules. */
function installedAtDataDir(): boolean {
  return existsSync(join(dataDir(), 'node_modules', '@huggingface', 'transformers'))
}

/**
 * One-time enablement of the local embeddings layer: install transformers.js
 * into ~/.claude-ctx so the installed bundles can resolve it, then build the
 * vectors shard for the current repo (downloads the model once, then offline).
 */
export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { 'skip-install': { type: 'boolean' } })
  const cfg = loadConfig(a.repo)

  if (a.values['skip-install'] !== true && !installedAtDataDir()) {
    const home = dataDir()
    mkdirSync(home, { recursive: true })
    // a minimal package.json so npm installs into ~/.claude-ctx/node_modules
    const pkgJson = join(home, 'package.json')
    if (!existsSync(pkgJson)) writeFileSync(pkgJson, JSON.stringify({ name: 'claude-ctx-runtime', private: true }) + '\n')
    out(`Installing ${PKG} into ${home} (one-time, ~?? MB)…`)
    try {
      execFileSync('npm', ['install', '--prefix', home, '--no-audit', '--no-fund', PKG], {
        stdio: 'inherit',
        timeout: 300_000,
      })
    } catch {
      out(`Could not auto-install. Run manually:\n  npm install --prefix "${home}" ${PKG}`)
      return 1
    }
  }

  if (!(await transformersAvailable())) {
    out('transformers.js still not resolvable — embeddings disabled.')
    return 1
  }

  if (!loadMeta(a.repo)) {
    out('No index yet — building it first…')
    await buildIndex(a.repo, { mode: 'full' })
  }
  out('Building embeddings (downloads the model on first run, then fully offline)…')
  const t0 = Date.now()
  const r = await buildVectors(a.repo, cfg)
  if (r.skipped) {
    out('Embeddings skipped — model load failed.')
    return 1
  }
  out(`Done: ${r.built} files embedded with ${r.model} in ${Date.now() - t0}ms.`)
  out('Semantic/hybrid retrieval is now active for `ctx pack` and mcp__ctx__context_pack.')
  return 0
}
