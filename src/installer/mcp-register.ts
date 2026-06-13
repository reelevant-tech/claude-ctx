import { execFileSync } from 'node:child_process'

function runClaude(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('claude', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) }
  }
}

/** Register the ctx MCP server at user scope. ctxHookAbs is a real absolute path. */
export function registerMcp(ctxHookAbs: string): { ok: boolean; message: string } {
  const manual = `claude mcp add --scope user ctx -- "${ctxHookAbs}" mcp`
  // probe for the claude CLI
  const probe = runClaude(['--version'])
  if (!probe.ok) {
    return { ok: false, message: `claude CLI not found. Register manually:\n  ${manual}` }
  }
  runClaude(['mcp', 'remove', '--scope', 'user', 'ctx']) // ignore failure
  const add = runClaude(['mcp', 'add', '--scope', 'user', 'ctx', '--', ctxHookAbs, 'mcp'])
  if (!add.ok) {
    return { ok: false, message: `mcp add failed: ${add.out.trim()}\nRegister manually:\n  ${manual}` }
  }
  return { ok: true, message: 'Registered MCP server "ctx" at user scope (tools: mcp__ctx__*).' }
}

export function unregisterMcp(): { ok: boolean; message: string } {
  const probe = runClaude(['--version'])
  if (!probe.ok) return { ok: false, message: 'claude CLI not found; nothing to unregister.' }
  const r = runClaude(['mcp', 'remove', '--scope', 'user', 'ctx'])
  return { ok: r.ok, message: r.ok ? 'Removed MCP server "ctx".' : `mcp remove: ${r.out.trim()}` }
}
