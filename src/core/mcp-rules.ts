/** Bash guard suggestion when the model tries to shell-invoke MCP tools. */
export const MCP_SHELL_GUARD_SUGGESTION =
  'mcp__ctx__* are agent MCP tools — invoke via the tool call UI, not Bash. Example: mcp__ctx__trace_symbol({ symbol: "Foo" }). CLI: ~/.claude-ctx/bin/ctx trace Foo'

/** Bash guard when the model shells out to ctx/trace_symbol instead of MCP tools. */
export const CTX_CLI_GUARD_SUGGESTION =
  'indexed lookups — invoke mcp__ctx__trace_symbol or mcp__ctx__symbol_search via the agent tool UI, not Bash'

/** Injected at session start / CLAUDE.md — keep token-cheap. */
export const MCP_AGENT_RULE =
  'mcp__ctx__* are Claude Code MCP tools only: use the agent tool interface, never Bash (no which/exec/trace_symbol/ctx trace). Verify: ctx doctor; CLI: ~/.claude-ctx/bin/ctx'

/** True when a bash sub-command treats an mcp__ctx__ tool name as a shell executable. */
export function isMcpShellMisuse(sub: string): boolean {
  const t = sub.trim()
  if (/^(which|command|type|hash)\s+(-[a-zA-Z]+\s+)*mcp__ctx__\w*/.test(t)) return true
  if (/^mcp__ctx__\w*(\s|$)/.test(t)) return true
  if (/\b(exec|eval|source)\s+.*mcp__ctx__/.test(t)) return true
  return false
}

/** True when a bash sub-command invokes ctx CLI or trace_symbol instead of MCP tools. */
export function isCtxCliMisuse(sub: string): boolean {
  const t = sub.trim()
  if (/^trace_symbol(\s|$)/.test(t)) return true
  if (
    /^ctx\s+(pack|symbols|related|deps|trace|references|calls|symbol_tree|overview|tree|tests|recent|risky|index)\b/.test(
      t,
    )
  )
    return true
  return false
}
