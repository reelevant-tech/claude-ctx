import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir, findRepoRoot } from '../../core/paths'
import { loadMeta } from '../../core/store/shards'
import { MARKER } from '../../installer/settings-merge'
import { out, parseCommon } from '../shared'

interface Check {
  name: string
  pass: boolean
  detail: string
}

function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json')
}

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const checks: Check[] = []
  const bin = join(dataDir(), 'bin')

  const bundles = ['cli.cjs', 'hook.cjs', 'mcp.cjs', 'ctx-hook']
  const missing = bundles.filter((f) => !existsSync(join(bin, f)))
  checks.push({
    name: 'bundles installed',
    pass: missing.length === 0,
    detail: missing.length === 0 ? bin : `missing: ${missing.join(', ')}`,
  })

  // ctx-hook resolves node + runs a hook end-to-end
  let hookOk = false
  let hookDetail = 'not run'
  const wrapper = join(bin, 'ctx-hook')
  if (existsSync(wrapper)) {
    try {
      const res = spawnSync('sh', [wrapper, 'session-start'], {
        input: JSON.stringify({ session_id: 'doctor', cwd: a.repo, source: 'startup' }),
        encoding: 'utf8',
        timeout: 130_000,
      })
      const trimmed = (res.stdout ?? '').trim()
      JSON.parse(trimmed || '{}')
      hookOk = res.status === 0
      hookDetail = hookOk ? 'session-start returned valid JSON' : `exit ${res.status}`
    } catch (e) {
      hookDetail = e instanceof Error ? e.message : String(e)
    }
  }
  checks.push({ name: 'hook wrapper runs', pass: hookOk, detail: hookDetail })

  // settings.json has our entries
  const sp = settingsPath()
  let settingsOk = false
  let settingsDetail = 'not found'
  if (existsSync(sp)) {
    try {
      const obj = JSON.parse(readFileSync(sp, 'utf8')) as { hooks?: Record<string, unknown[]> }
      let count = 0
      for (const groups of Object.values(obj.hooks ?? {})) {
        if (!Array.isArray(groups)) continue
        for (const g of groups) {
          const hooks = (g as { hooks?: { command?: string }[] }).hooks ?? []
          if (hooks.some((h) => h.command?.includes(MARKER))) count++
        }
      }
      settingsOk = count >= 7
      settingsDetail = `${count} claude-ctx hook groups`
    } catch {
      settingsDetail = 'parse error'
    }
  }
  checks.push({ name: 'settings.json hooks', pass: settingsOk, detail: settingsDetail })

  // MCP registered (warn-only if claude missing)
  let mcpDetail = 'claude CLI not found (skipped)'
  let mcpPass = true
  try {
    const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 30_000 })
    mcpPass = /\bctx\b/.test(list)
    mcpDetail = mcpPass ? 'ctx registered' : 'ctx NOT registered (run ctx install)'
  } catch {
    /* keep skip */
  }
  checks.push({ name: 'MCP server registered', pass: mcpPass, detail: mcpDetail })

  // index for cwd
  const root = findRepoRoot(a.repo).root
  const meta = loadMeta(root)
  let idxDetail = 'no index (run ctx index)'
  if (meta) {
    const ageH = ((Date.now() / 1000 - meta.indexedAt) / 3600).toFixed(1)
    idxDetail = `${meta.fileCount} files, ${meta.projectType}, ${ageH}h old${meta.partial ? ' (building)' : ''}`
  }
  checks.push({ name: 'index for cwd', pass: meta !== null, detail: idxDetail })

  // report
  out('claude-ctx doctor:')
  let allPass = true
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL'
    if (!c.pass) allPass = false
    out(`  [${mark}] ${c.name} — ${c.detail}`)
  }
  return allPass ? 0 : 1
}
