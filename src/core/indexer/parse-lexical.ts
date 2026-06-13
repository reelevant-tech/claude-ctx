import type { Lang, ParseResult, ParsedSymbol, SymbolKind } from '../types'

const SIG_MAX = 120
const HEADINGS_CAP = 10

const KIND_MAP: Record<string, SymbolKind> = {
  function: 'fn',
  class: 'class',
  interface: 'iface',
  type: 'type',
  enum: 'enum',
  const: 'const',
  let: 'var',
  var: 'var',
}

const DECL_RE =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)(?:\s*\*)?\s+([A-Za-z_$][A-Za-z0-9_$]*)/
const IMPORT_FROM_RE = /^import\s.*\sfrom\s+['"]([^'"]+)['"]/
const EXPORT_FROM_RE = /^export\s.*\sfrom\s+['"]([^'"]+)['"]/
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const DEFAULT_EXPORT_RE = /^export\s+default\b/
const HEADING_RE = /^#{1,3} (.+)$/

/** Zero-dependency line-based fallback parser (used when the TS parser is unavailable/too big). */
export function parseLexical(content: string, lang: Lang): ParseResult {
  const empty: ParseResult = { symbols: [], imports: [], exports: [], docHeadings: [] }

  if (lang === 'md') {
    const docHeadings: string[] = []
    for (const line of content.split(/\r?\n/)) {
      const m = HEADING_RE.exec(line)
      if (m?.[1] !== undefined) {
        docHeadings.push(m[1].trim())
        if (docHeadings.length >= HEADINGS_CAP) break
      }
    }
    return { ...empty, docHeadings }
  }

  if (lang !== 'ts' && lang !== 'js') return empty

  const symbols: ParsedSymbol[] = []
  const imports: string[] = []
  const exportNames: string[] = []

  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const im = IMPORT_FROM_RE.exec(line) ?? EXPORT_FROM_RE.exec(line)
    if (im?.[1] !== undefined) imports.push(im[1])
    for (const rm of line.matchAll(REQUIRE_RE)) {
      if (rm[1] !== undefined) imports.push(rm[1])
    }

    if (DEFAULT_EXPORT_RE.test(line)) exportNames.push('default')

    const dm = DECL_RE.exec(line)
    if (dm === null) continue
    const exported = dm[1] !== undefined
    const keyword = dm[2]
    const name = dm[3]
    if (keyword === undefined || name === undefined) continue
    const k = KIND_MAP[keyword]
    if (k === undefined) continue
    // only fn/class are worth keeping when not exported
    if (!exported && k !== 'fn' && k !== 'class') continue
    symbols.push({ n: name, k, l: i + 1, x: exported, sig: line.trim().slice(0, SIG_MAX) })
    if (exported) exportNames.push(name)
  }

  return {
    symbols,
    imports: [...new Set(imports)],
    exports: [...new Set(exportNames)],
    docHeadings: [],
  }
}
