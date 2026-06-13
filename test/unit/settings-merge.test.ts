import { describe, expect, it } from 'vitest'
import { buildHookEntries, MARKER, mergeHooks, removeHooks } from '../../src/installer/settings-merge'

const HOOK = '"$HOME"/.claude-ctx/bin/ctx-hook'

// representative of the user's real settings shape
const REAL = JSON.stringify(
  {
    permissions: { allow: ['Read', 'Edit', 'Bash', 'WebFetch'] },
    defaultMode: 'acceptEdits',
    enableAllProjectMcpServers: true,
    effortLevel: 'xhigh',
    model: 'claude-fable-5',
    theme: 'dark',
  },
  null,
  2,
)

describe('mergeHooks', () => {
  it('preserves every non-hooks key unchanged', () => {
    const merged = JSON.parse(mergeHooks(REAL, HOOK))
    const orig = JSON.parse(REAL)
    for (const k of Object.keys(orig)) {
      expect(merged[k]).toEqual(orig[k])
    }
  })

  it('adds all 6 claude-ctx event groups', () => {
    const merged = JSON.parse(mergeHooks(REAL, HOOK))
    const events = Object.keys(buildHookEntries(HOOK))
    for (const ev of events) {
      expect(merged.hooks[ev]).toBeTruthy()
      const json = JSON.stringify(merged.hooks[ev])
      expect(json).toContain(MARKER)
    }
    expect(events.length).toBe(6)
  })

  it('observes MCP tool calls via a PostToolUse mcp__ctx__.* matcher', () => {
    const groups = buildHookEntries(HOOK).PostToolUse as { matcher?: string }[]
    expect(groups.some((g) => g.matcher === 'mcp__ctx__.*')).toBe(true)
  })

  it('is idempotent — merging twice is byte-identical', () => {
    const once = mergeHooks(REAL, HOOK)
    const twice = mergeHooks(once, HOOK)
    expect(twice).toBe(once)
  })

  it('preserves a user-defined PreToolUse hook and appends ours after it', () => {
    const withUser = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-guard.sh' }] }],
      },
    })
    const merged = JSON.parse(mergeHooks(withUser, HOOK))
    const cmds = merged.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command),
    )
    expect(cmds).toContain('/usr/local/bin/my-guard.sh') // user entry kept
    expect(cmds.some((c: string) => c.includes(MARKER))).toBe(true) // ours added
  })

  it('throws on invalid JSON (caller handles)', () => {
    expect(() => mergeHooks('{ not json', HOOK)).toThrow()
  })
})

describe('removeHooks', () => {
  it('restores the original object after a merge round-trip', () => {
    const merged = mergeHooks(REAL, HOOK)
    const removed = JSON.parse(removeHooks(merged))
    expect(removed).toEqual(JSON.parse(REAL))
  })

  it('keeps user hooks while dropping only ours', () => {
    const withUser = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/my/guard.sh' }] }],
      },
    })
    const merged = mergeHooks(withUser, HOOK)
    const removed = JSON.parse(removeHooks(merged))
    expect(removed.hooks.PreToolUse).toHaveLength(1)
    expect(removed.hooks.PreToolUse[0].hooks[0].command).toBe('/my/guard.sh')
  })

  it('drops an emptied hooks object entirely', () => {
    const merged = mergeHooks('{}', HOOK)
    const removed = JSON.parse(removeHooks(merged))
    expect(removed.hooks).toBeUndefined()
  })
})
