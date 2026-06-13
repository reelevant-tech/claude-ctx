import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../core/config'
import { buildVectors } from '../core/embed/build'
import { transformersAvailable } from '../core/embed/embedder'
import { gitTopLevel } from '../core/git'
import { buildIndex } from '../core/indexer/index'
import { dataDir } from '../core/paths'
import { loadMeta } from '../core/store/shards'

const PKG = '@huggingface/transformers'

function out(s: string): void {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n')
}

/** Resolvable from ~/.claude-ctx (where the installed bundles look), not just dev node_modules. */
export function transformersInstalledAtDataDir(): boolean {
  return existsSync(join(dataDir(), 'node_modules', '@huggingface', 'transformers'))
}

export async function installTransformersRuntime(skipInstall = false): Promise<boolean> {
  if (skipInstall !== true && !transformersInstalledAtDataDir()) {
    const home = dataDir()
    mkdirSync(home, { recursive: true })
    const pkgJson = join(home, 'package.json')
    if (!existsSync(pkgJson)) {
      writeFileSync(pkgJson, JSON.stringify({ name: 'claude-ctx-runtime', private: true }) + '\n')
    }
    out(`Installing ${PKG} into ${home} (one-time, ~50MB)…`)
    try {
      execFileSync('npm', ['install', '--prefix', home, '--no-audit', '--no-fund', PKG], {
        stdio: 'inherit',
        timeout: 300_000,
      })
    } catch {
      out(`Could not auto-install. Run manually:\n  npm install --prefix "${home}" ${PKG}`)
      return false
    }
  }

  if (!(await transformersAvailable())) {
    out('transformers.js still not resolvable — embeddings disabled.')
    return false
  }
  return true
}

export type EmbedSetupOptions = {
  repo: string
  skipInstall?: boolean
  /** When true, install transformers only — skip index/vectors for the repo. */
  skipRepo?: boolean
}

/**
 * One-time enablement of the local embeddings layer: install transformers.js
 * into ~/.claude-ctx, then optionally build index + vectors for a git repo.
 */
export async function setupEmbeddings(opts: EmbedSetupOptions): Promise<number> {
  if (!(await installTransformersRuntime(opts.skipInstall))) return 1

  if (opts.skipRepo === true) {
    out('Semantic runtime ready. Run `ctx embed-setup` from a git repo to embed it.')
    return 0
  }

  const top = gitTopLevel(opts.repo)
  if (!top) {
    out('Not in a git repo — skipping index/embeddings. Run `ctx embed-setup` from a repo later.')
    return 0
  }

  const cfg = loadConfig(top)
  if (!loadMeta(top)) {
    out('No index yet — building it first…')
    await buildIndex(top, { mode: 'full' })
  }
  out('Building embeddings (downloads the model on first run, then fully offline)…')
  const t0 = Date.now()
  const r = await buildVectors(top, cfg)
  if (r.skipped) {
    out('Embeddings skipped — model load failed.')
    return 1
  }
  out(`Done: ${r.built} files embedded with ${r.model} in ${Date.now() - t0}ms.`)
  out('Semantic/hybrid retrieval is now active for `ctx pack` and mcp__ctx__context_pack.')
  return 0
}
