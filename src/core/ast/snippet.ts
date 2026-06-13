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
