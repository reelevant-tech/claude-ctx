import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../guard/redact'

/**
 * Read a single trimmed source line (1-based). Returns undefined on failure.
 * Secrets are redacted here so every emitter (trace_symbol, references, …) is
 * safe by construction — redaction is the snippet's contract, not the caller's.
 */
export function lineSnippet(root: string, file: string, line: number, max = 120): string | undefined {
  try {
    const raw = readFileSync(join(root, file), 'utf8').split('\n')[line - 1]
    if (raw === undefined) return undefined
    const t = redactSecrets(raw.trim())
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  } catch {
    return undefined
  }
}

/**
 * Read an inclusive 1-based line range as a raw block (indentation preserved).
 * Caps at maxLines, appending a marker for the elided tail. Output is
 * secret-redacted (idempotent — callers may re-redact harmlessly).
 */
export function rangeSnippet(
  root: string,
  file: string,
  startLine: number,
  endLine: number,
  maxLines = 60,
): string | undefined {
  try {
    const all = readFileSync(join(root, file), 'utf8').split('\n')
    const start = Math.max(1, startLine)
    const end = Math.min(all.length, Math.max(start, endLine))
    const lines = all.slice(start - 1, end)
    if (lines.length === 0) return undefined
    if (lines.length > maxLines) {
      const head = lines.slice(0, maxLines)
      const elided = lines.length - maxLines
      head.push(`… (+${elided} more line${elided === 1 ? '' : 's'}, to L${end})`)
      return redactSecrets(head.join('\n'))
    }
    return redactSecrets(lines.join('\n'))
  } catch {
    return undefined
  }
}
