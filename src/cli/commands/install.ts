import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dataDir } from '../../core/paths'
import { writeFileAtomic } from '../../core/store/shards'
import { installArtifacts } from '../../installer/artifacts'
import { setupEmbeddings } from '../../installer/embed-runtime'
import { registerMcp } from '../../installer/mcp-register'
import { mergeHooks } from '../../installer/settings-merge'
import { out, parseCommon } from '../shared'

const CTX_HOOK_INVOCATION = '"$HOME"/.claude-ctx/bin/ctx-hook'
const CTX_BIN_DIR = join(homedir(), '.claude-ctx', 'bin')

function ctxOnPath(): boolean {
  const path = process.env.PATH ?? ''
  return path.split(':').some((d) => d === CTX_BIN_DIR || d === join(homedir(), '.claude-ctx', 'bin'))
}

function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json')
}

/** Locate the built dist dir: next to this bundle, else ./dist in cwd (dev). */
function findDistDir(): string | null {
  const beside = dirname(process.argv[1] ?? '')
  if (existsSync(join(beside, 'hook.cjs'))) return beside
  const dev = join(process.cwd(), 'dist')
  if (existsSync(join(dev, 'hook.cjs'))) return dev
  return null
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { 'no-mcp': { type: 'boolean' }, 'no-embed': { type: 'boolean' } })
  const dist = findDistDir()
  if (!dist) {
    process.stderr.write('Could not find built bundles (dist/hook.cjs). Run: npm run build\n')
    return 1
  }
  installArtifacts(dist)
  out(`Installed bundles to ${join(dataDir(), 'bin')}`)

  // settings.json merge
  const sp = settingsPath()
  if (existsSync(sp)) {
    let raw: string
    try {
      raw = readFileSync(sp, 'utf8')
      JSON.parse(raw) // validate before touching
    } catch (e) {
      process.stderr.write(
        `ABORT: ${sp} is not valid JSON (${e instanceof Error ? e.message : e}). No changes made.\n`,
      )
      return 1
    }
    const backup = `${sp}.ctx-bak-${Math.floor(Date.now() / 1000)}`
    copyFileSync(sp, backup)
    const merged = mergeHooks(raw, CTX_HOOK_INVOCATION)
    writeFileAtomic(sp, merged)
    out(`Merged hooks + MCP permissions into ${sp} (backup: ${backup})`)
  } else {
    const merged = mergeHooks('{}', CTX_HOOK_INVOCATION)
    writeFileAtomic(sp, merged)
    out(`Created ${sp} with claude-ctx hooks and MCP permissions`)
  }

  // MCP registration
  if (a.values['no-mcp'] !== true) {
    const ctxHookAbs = realpathSync(join(dataDir(), 'bin', 'ctx-hook'))
    const r = registerMcp(ctxHookAbs)
    out(r.message)
  }

  // Embeddings runtime + optional repo vectors (same as embed-setup)
  if (a.values['no-embed'] !== true) {
    out('')
    const embedCode = await setupEmbeddings({ repo: a.repo })
    if (embedCode !== 0) return embedCode
  }

  out('')
  if (!ctxOnPath()) {
    out(`Add ~/.claude-ctx/bin to PATH to run \`ctx\` from anywhere:`)
    out(`  export PATH="${CTX_BIN_DIR}:$PATH"`)
  }
  out('Next: open Claude Code in any repo — context will be injected automatically.')
  return 0
}
