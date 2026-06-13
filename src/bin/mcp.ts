/**
 * claude-ctx MCP stdio server. stdout is the JSON-RPC channel — diagnostics go
 * to stderr only. Repo root = the cwd Claude Code launched us in.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { findRepoRoot } from '../core/paths'
import { createServer } from '../mcp/tools'

async function main(): Promise<void> {
  const root = findRepoRoot(process.cwd()).root
  const server = createServer({ root })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((e) => {
  process.stderr.write(`ctx-mcp fatal: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
