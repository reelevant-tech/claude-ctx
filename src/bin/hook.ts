/**
 * Hook hot-path entrypoint. Reads a HookInput JSON on stdin, dispatches by the
 * event passed as argv[2], prints a HookOutput JSON. Fails OPEN: any error or
 * timeout prints '{}' and exits 0 so a broken context layer never breaks a
 * Claude Code session. This bundle MUST NOT pull in the `typescript` package
 * (enforced by the esbuild hook-bundle guard).
 */
import { handle as preBash } from '../hooks/pre-bash'
import { handle as preEdit } from '../hooks/pre-edit'
import { handle as preGrep } from '../hooks/pre-grep'
import { handle as preRead } from '../hooks/pre-read'
import { handle as postTool } from '../hooks/post-tool'
import { handle as sessionStart } from '../hooks/session-start'
import { handle as stop } from '../hooks/stop'
import { handle as userPromptSubmit } from '../hooks/user-prompt-submit'
import type { HookInput, HookOutput } from '../core/types'

type Handler = (input: HookInput) => Promise<HookOutput>

const HANDLERS: Record<string, Handler> = {
  'session-start': sessionStart,
  'user-prompt-submit': userPromptSubmit,
  'pre-bash': preBash,
  'pre-edit': preEdit,
  'pre-read': preRead,
  'pre-grep': preGrep,
  'post-tool': postTool,
  stop,
  'session-end': stop,
}

function emit(o: HookOutput): void {
  try {
    process.stdout.write(JSON.stringify(o))
  } catch {
    process.stdout.write('{}')
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  // hard watchdog — never hang a session
  const watchdog = setTimeout(() => {
    process.stdout.write('{}')
    process.exit(0)
  }, 8000)
  watchdog.unref()

  const event = process.argv[2] ?? ''
  const handler = HANDLERS[event]
  if (!handler) {
    emit({})
    return
  }
  let input: HookInput = {}
  try {
    const raw = await readStdin()
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {}
  } catch {
    emit({})
    return
  }
  try {
    emit(await handler(input))
  } catch {
    emit({})
  }
}

main().catch(() => process.stdout.write('{}'))
