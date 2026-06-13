import type { ParsedSymbol, ParseResult, SymbolKind } from '../types'

/** Blank out # comments and string literals; preserve newlines/positions. */
function stripCode(src: string): string {
  const n = src.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    const c = src[i]!
    // # comment — blank to end of line
    if (c === '#') {
      while (i < n && src[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }
    // triple-quoted strings: """ or '''
    if ((c === '"' || c === "'") && src[i + 1] === c && src[i + 2] === c) {
      out.push(' ', ' ', ' ')
      i += 3
      while (i < n) {
        if (src[i] === c && src[i + 1] === c && src[i + 2] === c) {
          out.push(' ', ' ', ' ')
          i += 3
          break
        }
        out.push(src[i] === '\n' ? '\n' : ' ')
        i++
      }
      continue
    }
    // single or double-quoted strings
    if (c === '"' || c === "'") {
      out.push(' ')
      i++
      while (i < n) {
        const d = src[i]!
        if (d === '\\' && i + 1 < n) {
          out.push(' ', src[i + 1] === '\n' ? '\n' : ' ')
          i += 2
          continue
        }
        out.push(d === '\n' ? '\n' : ' ')
        i++
        if (d === c) break
      }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

const FUNC_RE = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)[\s:(]/
const IMPORT_RE = /^(?:from\s+(\S+)\s+)?import\s+(.+)/
// module-level ALL_CAPS constants (at least 2 chars, no leading underscore)
const CONST_RE = /^([A-Z][A-Z0-9_]{1,})\s*=/

interface ClassFrame {
  indent: number
}

export function parsePython(content: string): ParseResult {
  const stripped = stripCode(content)
  const origLines = content.split('\n')
  const strippedLines = stripped.split('\n')
  const symbols: ParsedSymbol[] = []
  const imports: string[] = []
  const exports: string[] = []
  const seenImports = new Set<string>()
  const seenExports = new Set<string>()

  const addImport = (mod: string): void => {
    const base = (mod.split('.')[0] ?? '').trim()
    if (!base || seenImports.has(base)) return
    seenImports.add(base)
    imports.push(base)
  }

  const addExport = (name: string): void => {
    if (!name || seenExports.has(name)) return
    seenExports.add(name)
    exports.push(name)
  }

  // track active class frames by their indent level
  const classStack: ClassFrame[] = []

  for (let i = 0; i < strippedLines.length; i++) {
    const sline = strippedLines[i]!
    const lineNo = i + 1
    const trimmed = sline.trimStart()
    if (!trimmed) continue
    const indent = sline.length - trimmed.length
    const orig = origLines[i] ?? ''

    // pop class frames when indentation returns to or past the class level
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop()
    }

    const fm = FUNC_RE.exec(sline)
    if (fm) {
      const name = fm[3]!
      const k: SymbolKind = classStack.length > 0 ? 'method' : 'fn'
      const pub = !name.startsWith('_')
      symbols.push({ n: name, k, l: lineNo, x: pub, sig: orig.trim().slice(0, 120) })
      if (k === 'fn' && pub) addExport(name)
      continue
    }

    const cm = CLASS_RE.exec(sline)
    if (cm) {
      const name = cm[2]!
      const pub = !name.startsWith('_')
      symbols.push({ n: name, k: 'class', l: lineNo, x: pub, sig: orig.trim().slice(0, 120) })
      classStack.push({ indent })
      if (pub) addExport(name)
      continue
    }

    // imports and module-level constants at indent 0
    if (indent === 0) {
      const im = IMPORT_RE.exec(trimmed)
      if (im) {
        if (im[1]) {
          addImport(im[1])
        } else {
          for (const part of (im[2] ?? '').split(',')) {
            const name = (part.trim().split(/\s+as\s+/)[0] ?? '').trim()
            addImport(name)
          }
        }
        continue
      }

      const cm2 = CONST_RE.exec(trimmed)
      if (cm2 && classStack.length === 0) {
        const name = cm2[1]!
        symbols.push({ n: name, k: 'const', l: lineNo, x: true, sig: orig.trim().slice(0, 120) })
        addExport(name)
      }
    }
  }

  return { symbols, imports, exports, docHeadings: [], modDecls: [], hasCfgTest: false }
}
