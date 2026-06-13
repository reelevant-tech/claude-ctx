import { resolve } from 'node:path'
import { loadConfig } from '../../core/config'
import { buildVectors } from '../../core/embed/build'
import { discoverRepos, gitTopLevel } from '../../core/git'
import { buildIndex } from '../../core/indexer/index'
import { out, parseCommon } from '../shared'

/** Build the structural index + (optionally) vectors for one git repo root. */
async function indexOne(root: string, full: boolean, noEmbed: boolean): Promise<void> {
  const stats = await buildIndex(root, { mode: full ? 'full' : undefined })
  out(
    `indexed ${root}: ${stats.fileCount} files, ${stats.symbolCount} symbols, ` +
      `${stats.skippedCount} skipped, ${stats.durationMs}ms (${stats.mode})`,
  )
  const cfg = loadConfig(root)
  if (cfg.embeddings.enabled && !noEmbed) {
    const t0 = Date.now()
    const r = await buildVectors(root, cfg)
    if (r.skipped) out('  embeddings: skipped (run `ctx embed-setup` to enable local semantic search)')
    else out(`  embeddings: ${r.built} built / ${r.reused} reused, ${r.entries} chunks, ${Date.now() - t0}ms`)
  }
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, {
    full: { type: 'boolean' },
    'no-embed': { type: 'boolean' },
    all: { type: 'boolean' },
    workspace: { type: 'string' },
  })
  const full = a.values.full === true
  const noEmbed = a.values['no-embed'] === true

  // multi-repo: discover under a workspace and index each independently
  const workspaceMode = a.values.all === true || typeof a.values.workspace === 'string'
  if (workspaceMode) {
    const workspace = typeof a.values.workspace === 'string' ? resolve(a.values.workspace) : process.cwd()
    const repos = discoverRepos(workspace)
    if (repos.length === 0) {
      out(`No git repositories found under ${workspace}`)
      return 0
    }
    out(`Discovered ${repos.length} repo(s) under ${workspace}:`)
    let ok = 0
    for (const dir of repos) {
      const root = gitTopLevel(dir) ?? dir
      try {
        await indexOne(root, full, noEmbed)
        ok++
      } catch (e) {
        out(`  FAILED ${root}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    out(`Done: ${ok}/${repos.length} indexed.`)
    return ok === repos.length ? 0 : 1
  }

  // single repo: resolve the GIT top-level (never the cwd / workspace folder)
  const start = typeof a.values.repo === 'string' ? resolve(a.values.repo) : process.cwd()
  const root = gitTopLevel(start)
  if (!root) {
    process.stderr.write(
      `Not inside a git repository: ${start}\n` +
        `Run \`ctx index --all\` to index every repo under this folder, ` +
        `or \`ctx index --workspace <path>\`.\n`,
    )
    return 1
  }
  await indexOne(root, full, noEmbed)
  return 0
}
