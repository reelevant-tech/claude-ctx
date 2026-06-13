import { describe, expect, it } from 'vitest'
import { isCtxCliMisuse, isMcpShellMisuse, MCP_AGENT_RULE } from '../../src/core/mcp-rules'

describe('isCtxCliMisuse', () => {
  it('flags trace_symbol and ctx subcommands', () => {
    expect(isCtxCliMisuse('trace_symbol AutomaticIndexResolving')).toBe(true)
    expect(isCtxCliMisuse('ctx trace Foo')).toBe(true)
    expect(isCtxCliMisuse('ctx references Foo')).toBe(true)
  })

  it('allows unrelated shell commands', () => {
    expect(isCtxCliMisuse('npm test')).toBe(false)
    expect(isCtxCliMisuse('echo ctx trace foo')).toBe(false)
  })
})

describe('isMcpShellMisuse', () => {
  it('flags which/command/type on mcp tools', () => {
    expect(isMcpShellMisuse('which mcp__ctx__context_pack')).toBe(true)
    expect(isMcpShellMisuse('command -v mcp__ctx__symbol_search')).toBe(true)
    expect(isMcpShellMisuse('type mcp__ctx__related_files')).toBe(true)
  })

  it('flags direct shell invocation', () => {
    expect(isMcpShellMisuse('mcp__ctx__context_pack')).toBe(true)
    expect(isMcpShellMisuse('mcp__ctx__context_pack --task foo')).toBe(true)
  })

  it('allows grep/search that merely mentions the prefix in a pattern', () => {
    expect(isMcpShellMisuse("grep -r mcp__ctx__ src/")).toBe(false)
    expect(isMcpShellMisuse('rg mcp__ctx__context_pack README.md')).toBe(false)
  })
})

describe('MCP_AGENT_RULE', () => {
  it('forbids shell invocation', () => {
    expect(MCP_AGENT_RULE).toContain('never Bash')
    expect(MCP_AGENT_RULE).toContain('trace_symbol')
  })
})
