import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir } from '../../core/paths'
import { writeFileAtomic } from '../../core/store/shards'
import { unregisterMcp } from '../../installer/mcp-register'
import { removeHooks } from '../../installer/settings-merge'
import { out, parseCommon } from '../shared'

function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json')
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { purge: { type: 'boolean' } })
  const sp = settingsPath()
  if (existsSync(sp)) {
    let raw: string
    try {
      raw = readFileSync(sp, 'utf8')
      JSON.parse(raw)
    } catch (e) {
      process.stderr.write(`ABORT: ${sp} is not valid JSON (${e instanceof Error ? e.message : e}).\n`)
      return 1
    }
    copyFileSync(sp, `${sp}.ctx-bak-${Math.floor(Date.now() / 1000)}`)
    writeFileAtomic(sp, removeHooks(raw))
    out(`Removed claude-ctx hooks from ${sp}`)
  }
  const r = unregisterMcp()
  out(r.message)
  if (a.values.purge === true) {
    rmSync(join(dataDir(), 'repos'), { recursive: true, force: true })
    out('Purged indexed repo data.')
  }
  out('Done. Bundles remain in ~/.claude-ctx/bin (delete manually if desired).')
  return 0
}
