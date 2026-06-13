import type { ParsedSymbol, ParseResult, SymbolKind } from '../types'

interface Frame {
  kind: 'mod' | 'impl' | 'other'
  name: string
  isPub: boolean
}

const KIND_MAP: Record<string, SymbolKind> = {
  fn: 'fn',
  struct: 'struct',
  enum: 'enum',
  trait: 'trait',
  mod: 'mod',
  type: 'type',
  const: 'const',
  static: 'const',
  union: 'struct',
}

// modifiers (async/unsafe/extern/const/default) backtrack to zero when the
// keyword itself is const/static, so `pub const MAX` and `pub const fn f` both work
const ITEM_RE =
  /(?:\b(pub)\s*(?:\(\s*[^()]*\))?\s+)?(?:(?:async|unsafe|extern|const|default)\s+)*\b(fn|struct|enum|trait|mod|type|const|static|union)\s+(?:mut\s+)?((?!(?:fn|struct|enum|trait|mod|type|const|static|union|impl|where|for|in|pub|mut|use|as)\b)[A-Za-z_]\w*)/
const IMPL_RE = /\bimpl\b/
const MACRO_RE = /\bmacro_rules!\s*([A-Za-z_]\w*)/
const USE_RE = /\buse\b/

/** Blank out comments, strings, raw strings and char literals; preserve newlines/positions. */
function stripCode(src: string): string {
  const n = src.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1
      out.push(' ', ' ')
      i += 2
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++
          out.push(' ', ' ')
          i += 2
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--
          out.push(' ', ' ')
          i += 2
        } else {
          out.push(src[i] === '\n' ? '\n' : ' ')
          i++
        }
      }
      continue
    }
    if (c === 'r' || (c === 'b' && src[i + 1] === 'r')) {
      const prev = src[i - 1]
      const wordBefore = prev !== undefined && /[A-Za-z0-9_]/.test(prev)
      if (!wordBefore) {
        const rPos = c === 'r' ? i : i + 1
        let j = rPos + 1
        while (j < n && src[j] === '#') j++
        if (src[j] === '"') {
          const closer = '"' + '#'.repeat(j - rPos - 1)
          const end = src.indexOf(closer, j + 1)
          const stop = end === -1 ? n : end + closer.length
          for (let p = i; p < stop; p++) out.push(src[p] === '\n' ? '\n' : ' ')
          i = stop
          continue
        }
      }
    }
    if (c === '"') {
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
        if (d === '"') break
      }
      continue
    }
    if (c === "'") {
      const next = src[i + 1]
      if (next === '\\') {
        let j = i + 3
        while (j < n && src[j] !== "'" && src[j] !== '\n') j++
        const stop = j < n && src[j] === "'" ? j + 1 : j
        for (let p = i; p < stop; p++) out.push(' ')
        i = stop
        continue
      }
      if (next !== undefined && next !== "'" && next !== '\n' && src[i + 2] === "'") {
        out.push(' ', ' ', ' ')
        i += 3
        continue
      }
      out.push("'") // lifetime
      i++
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

function countNl(s: string, end: number): number {
  let c = 0
  let p = s.indexOf('\n')
  while (p !== -1 && p < end) {
    c++
    p = s.indexOf('\n', p + 1)
  }
  return c
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function stripGenerics(s: string): string {
  let out = ''
  let depth = 0
  for (const ch of s) {
    if (ch === '<') depth++
    else if (ch === '>') {
      if (depth > 0) depth--
      else out += ch
    } else if (depth === 0) out += ch
  }
  return out
}

function parseImplHeader(seg: string, idx: number): { n: string; typeName: string } | null {
  let rest = seg.slice(idx + 4).replace(/^\s+/, '')
  if (rest.startsWith('<')) {
    let depth = 0
    let j = 0
    for (; j < rest.length; j++) {
      const ch = rest[j]
      if (ch === '<') depth++
      else if (ch === '>') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    rest = rest.slice(j)
  }
  const w = rest.search(/\bwhere\b/)
  if (w >= 0) rest = rest.slice(0, w)
  rest = stripGenerics(rest)
  const f = rest.search(/\bfor\b/)
  let first: string
  let second = ''
  if (f >= 0) {
    first = norm(rest.slice(0, f))
    second = norm(rest.slice(f + 3))
  } else {
    first = norm(rest)
  }
  if (first === '') return null
  const typePart = second !== '' ? second : first
  const tail = /([A-Za-z_]\w*)\s*$/.exec(typePart)
  return { n: second !== '' ? `${first} for ${second}` : first, typeName: tail?.[1] ?? typePart }
}

export function parseRust(content: string): ParseResult {
  const stripped = stripCode(content)
  const origLines = content.split('\n')
  const symbols: ParsedSymbol[] = []
  const imports: string[] = []
  const exports: string[] = []
  const modDecls: string[] = []
  const seenImports = new Set<string>()
  const seenExports = new Set<string>()
  const stack: Frame[] = []

  const modPath = (): string => stack.map((f) => f.name).join('::')

  const record = (n: string, k: SymbolKind, l: number, x: boolean, m: string): void => {
    const sig = (origLines[l - 1] ?? '').trim().slice(0, 120)
    const sym: ParsedSymbol = { n, k, l, x, sig }
    if (m !== '') sym.m = m
    symbols.push(sym)
  }

  const addExport = (name: string, isPub: boolean): void => {
    if (!isPub) return
    if (!stack.every((f) => f.kind === 'mod' && f.isPub)) return
    if (seenExports.has(name)) return
    seenExports.add(name)
    exports.push(name)
  }

  const addImport = (raw: string): void => {
    let p = raw
    const brace = p.indexOf('{')
    if (brace >= 0) p = p.slice(0, brace)
    const asIdx = p.search(/\bas\b/)
    if (asIdx >= 0) p = p.slice(0, asIdx)
    p = p.replace(/\s+/g, '')
    if (p.endsWith('::*')) p = p.slice(0, -3)
    while (p.endsWith('::')) p = p.slice(0, -2)
    if (p.startsWith('::')) p = p.slice(2)
    if (p === '' || seenImports.has(p)) return
    seenImports.add(p)
    imports.push(p)
  }

  const OTHER: Frame = { kind: 'other', name: '', isPub: false }

  const handleSegment = (seg: string, segLine: number, open: boolean): Frame => {
    const allMod = stack.every((f) => f.kind === 'mod')
    const top = stack[stack.length - 1]
    const implCtx =
      top !== undefined && top.kind === 'impl' && stack.slice(0, -1).every((f) => f.kind === 'mod')
    if (!allMod && !implCtx) return OTHER

    const cands: { t: 'item' | 'impl' | 'macro' | 'use'; m: RegExpExecArray }[] = []
    const im = ITEM_RE.exec(seg)
    if (im) cands.push({ t: 'item', m: im })
    const ip = IMPL_RE.exec(seg)
    if (ip) cands.push({ t: 'impl', m: ip })
    const mc = MACRO_RE.exec(seg)
    if (mc) cands.push({ t: 'macro', m: mc })
    const us = USE_RE.exec(seg)
    if (us) cands.push({ t: 'use', m: us })
    if (cands.length === 0) return OTHER
    cands.sort((a, b) => a.m.index - b.m.index)
    const best = cands[0]!
    const l = segLine + countNl(seg, best.m.index)

    if (best.t === 'use') {
      if (allMod) addImport(seg.slice(best.m.index + best.m[0].length))
      return OTHER
    }
    if (best.t === 'macro') {
      if (allMod && open) {
        const name = best.m[1] ?? ''
        const exported = seg.includes('#[macro_export]')
        record(name, 'macro', l, exported, modPath())
        addExport(name, exported)
      }
      return OTHER
    }
    if (best.t === 'impl') {
      if (allMod && open) {
        const hdr = parseImplHeader(seg, best.m.index)
        if (hdr) {
          record(hdr.n, 'impl', l, false, modPath())
          return { kind: 'impl', name: hdr.typeName, isPub: false }
        }
      }
      return OTHER
    }

    const isPub = best.m[1] !== undefined
    const kw = best.m[2] ?? ''
    const name = best.m[3] ?? ''
    const k = KIND_MAP[kw]
    if (k === undefined || name === '') return OTHER
    if (allMod) {
      record(name, k, l, isPub, modPath())
      addExport(name, isPub)
      if (kw === 'mod') {
        if (open) return { kind: 'mod', name, isPub }
        modDecls.push(name)
      }
      return OTHER
    }
    if (implCtx && kw === 'fn' && isPub && top !== undefined) {
      const mods = stack.slice(0, -1).map((f) => f.name)
      record(name, 'fn', l, true, [...mods, top.name].join('::'))
    }
    return OTHER
  }

  let seg = ''
  let segLine = 1
  let line = 1
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!
    if (c === '{') {
      stack.push(handleSegment(seg, segLine, true))
      seg = ''
      segLine = line
    } else if (c === '}') {
      if (stack.length > 0) stack.pop()
      seg = ''
      segLine = line
    } else if (c === ';') {
      handleSegment(seg, segLine, false)
      seg = ''
      segLine = line
    } else {
      seg += c
      if (c === '\n') line++
    }
  }

  return {
    symbols,
    imports,
    exports,
    docHeadings: [],
    hasCfgTest: content.includes('#[cfg(test)]'),
    modDecls,
  }
}
