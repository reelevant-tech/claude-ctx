import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read a single trimmed source line (1-based). Returns undefined on failure. */
export function lineSnippet(root: string, file: string, line: number, max = 120): string | undefined {
  try {
    const raw = readFileSync(join(root, file), 'utf8').split('\n')[line - 1]
    if (raw === undefined) return undefined
    const t = raw.trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  } catch {
    return undefined
  }
}

/**
 * Read an inclusive 1-based line range as a raw block (indentation preserved).
 * Caps at maxLines, appending a marker for the elided tail. Caller redacts.
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
      return head.join('\n')
    }
    return lines.join('\n')
  } catch {
    return undefined
  }
}
