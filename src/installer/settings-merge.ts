/**
 * Non-destructive merge of claude-ctx hooks into a Claude Code settings.json.
 * The ONLY code that mutates user state — correctness over cleverness.
 * Identity of our entries = any nested hook command contains MARKER.
 */
export const MARKER = '/.claude-ctx/'
export const MCP_PERMISSION_ALLOW = 'mcp__ctx__*'

interface HookCmd {
  type: string
  command: string
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks: HookCmd[]
}

/** The full claude-ctx hooks block. `ctxHookPath` is the wrapper invocation prefix. */
export function buildHookEntries(ctxHookPath: string): Record<string, HookGroup[]> {
  return {
    SessionStart: [
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: `${ctxHookPath} session-start`, timeout: 120 }],
      },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `${ctxHookPath} user-prompt-submit`, timeout: 10 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: `${ctxHookPath} pre-bash`, timeout: 10 }] },
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: `${ctxHookPath} pre-edit`, timeout: 10 }],
      },
      { matcher: 'Read', hooks: [{ type: 'command', command: `${ctxHookPath} pre-read`, timeout: 10 }] },
      {
        matcher: 'Grep|Glob',
        hooks: [{ type: 'command', command: `${ctxHookPath} pre-grep`, timeout: 10 }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Read|Edit|Write|MultiEdit|Bash',
        hooks: [{ type: 'command', command: `${ctxHookPath} post-tool`, timeout: 10 }],
      },
      {
        // observe index usage (context_pack/symbol_search/…) to reset the read-cascade streak
        matcher: 'mcp__ctx__.*',
        hooks: [{ type: 'command', command: `${ctxHookPath} post-tool`, timeout: 10 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: `${ctxHookPath} stop`, timeout: 30 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: `${ctxHookPath} session-end`, timeout: 30 }] }],
  }
}

function isOurs(group: unknown): boolean {
  if (typeof group !== 'object' || group === null) return false
  const hooks = (group as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some(
    (h) => typeof h === 'object' && h !== null && typeof (h as HookCmd).command === 'string' && (h as HookCmd).command.includes(MARKER),
  )
}

function mergePermissions(obj: Record<string, unknown>): void {
  const permissions = (typeof obj.permissions === 'object' && obj.permissions !== null
    ? obj.permissions
    : {}) as Record<string, unknown>
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as string[])] : []
  if (!allow.includes(MCP_PERMISSION_ALLOW)) allow.push(MCP_PERMISSION_ALLOW)
  permissions.allow = allow
  obj.permissions = permissions
}

function removePermissions(obj: Record<string, unknown>): void {
  if (typeof obj.permissions !== 'object' || obj.permissions === null) return
  const permissions = obj.permissions as Record<string, unknown>
  if (!Array.isArray(permissions.allow)) return
  const allow = (permissions.allow as string[]).filter((e) => e !== MCP_PERMISSION_ALLOW)
  if (allow.length === 0) delete permissions.allow
  else permissions.allow = allow
  if (Object.keys(permissions).length === 0) delete obj.permissions
}

/** Merge our hooks + MCP allowlist; preserve every other key and the user's own hook entries. */
export function mergeHooks(settingsJson: string, ctxHookPath: string): string {
  const obj = JSON.parse(settingsJson) as Record<string, unknown>
  const hooks = (typeof obj.hooks === 'object' && obj.hooks !== null ? obj.hooks : {}) as Record<
    string,
    unknown
  >
  const ours = buildHookEntries(ctxHookPath)
  for (const [event, ourGroups] of Object.entries(ours)) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const userKept = existing.filter((g) => !isOurs(g))
    hooks[event] = [...userKept, ...ourGroups]
  }
  obj.hooks = hooks
  mergePermissions(obj)
  return JSON.stringify(obj, null, 2) + '\n'
}

/** Remove only our entries; drop emptied event arrays and an emptied hooks object. */
export function removeHooks(settingsJson: string): string {
  const obj = JSON.parse(settingsJson) as Record<string, unknown>
  if (typeof obj.hooks !== 'object' || obj.hooks === null) return JSON.stringify(obj, null, 2) + '\n'
  const hooks = obj.hooks as Record<string, unknown>
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    const kept = (hooks[event] as unknown[]).filter((g) => !isOurs(g))
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (Object.keys(hooks).length === 0) delete obj.hooks
  removePermissions(obj)
  return JSON.stringify(obj, null, 2) + '\n'
}
