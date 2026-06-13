import { run as commandsCmd } from '../cli/commands/commands-cmd'
import { run as deps } from '../cli/commands/deps'
import { run as doctor } from '../cli/commands/doctor'
import { run as embedSetup } from '../cli/commands/embed-setup'
import { run as indexCmd } from '../cli/commands/index-cmd'
import { run as init } from '../cli/commands/init'
import { run as install } from '../cli/commands/install'
import { run as overview } from '../cli/commands/overview'
import { run as pack } from '../cli/commands/pack'
import { run as recent } from '../cli/commands/recent'
import { run as related } from '../cli/commands/related'
import { run as risky } from '../cli/commands/risky'
import { run as summary } from '../cli/commands/summary'
import { run as symbols } from '../cli/commands/symbols'
import { run as testsCmd } from '../cli/commands/tests-cmd'
import { run as tree } from '../cli/commands/tree'
import { run as uninstall } from '../cli/commands/uninstall'

type Cmd = (argv: string[]) => Promise<number>

const COMMANDS: Record<string, { run: Cmd; help: string }> = {
  index: { run: indexCmd, help: 'build/refresh the repo index (--full to force)' },
  overview: { run: overview, help: 'compact repo overview (project type, packages, commands, tree)' },
  tree: { run: tree, help: 'compact repo tree (--dir <d>)' },
  pack: { run: pack, help: 'context pack for a task: ctx pack "<task>" (--json, --budget N)' },
  symbols: { run: symbols, help: 'search symbols: ctx symbols <query> (--kind --exported --limit)' },
  related: { run: related, help: 'related files for a path: ctx related <path>' },
  deps: { run: deps, help: 'dependency trace: ctx deps <from> [to]' },
  tests: { run: testsCmd, help: 'tests covering a path + how to run them' },
  recent: { run: recent, help: 'recently changed files (--days --limit)' },
  risky: { run: risky, help: 'risk classification for a path' },
  commands: { run: commandsCmd, help: 'detected project commands' },
  summary: { run: summary, help: 'session memory summary' },
  init: { run: init, help: 'write a managed claude-ctx block into CLAUDE.md (--rules)' },
  'embed-setup': { run: embedSetup, help: 'enable local offline semantic search (installs the model)' },
  install: { run: install, help: 'install hooks + MCP server globally (--no-mcp)' },
  uninstall: { run: uninstall, help: 'remove hooks + MCP server (--purge)' },
  doctor: { run: doctor, help: 'diagnose the installation' },
}

function usage(): void {
  process.stderr.write('ctx — smart context layer for Claude Code\n\nCommands:\n')
  for (const [name, { help }] of Object.entries(COMMANDS)) {
    process.stderr.write(`  ${name.padEnd(10)} ${help}\n`)
  }
  process.stderr.write('\nGlobal flags: --repo <path>  --json\n')
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage()
    return cmd ? 0 : 1
  }
  const entry = COMMANDS[cmd]
  if (!entry) {
    process.stderr.write(`Unknown command: ${cmd}\n\n`)
    usage()
    return 1
  }
  return entry.run(process.argv.slice(3))
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.stderr.write(`ctx: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  })
