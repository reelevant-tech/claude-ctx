import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import type { LoadedIndex, SymbolRecord } from '../types'

export interface TsReference {
  file: string
  line: number
}

const TS_EXT = /\.(tsx?|jsx?|mjs|cjs)$/

function isTsFile(path: string): boolean {
  return TS_EXT.test(path)
}

function absPath(root: string, rel: string): string {
  return join(root, rel)
}

function toRel(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel.includes('node_modules')) return null
  return rel.split('\\').join('/')
}

interface LangCache {
  root: string
  mtime: number
  service: ts.LanguageService | null
  indexed: Set<string>
}

let langCache: LangCache | null = null

/** Drop cached language service (e.g. after index refresh). */
export function clearTsRefsCache(): void {
  langCache = null
}

function readCompilerOptions(root: string): ts.CompilerOptions {
  const cfgPath = join(root, 'tsconfig.json')
  if (!existsSync(cfgPath)) {
    return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  }
  const config = ts.readConfigFile(cfgPath, (p) => readFileSync(p, 'utf8'))
  if (config.error) {
    return { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  return parsed.options
}

function getLanguageService(root: string, idx: LoadedIndex, cacheKey: number): ts.LanguageService | null {
  if (langCache && langCache.root === root && langCache.mtime === cacheKey) return langCache.service

  const relFiles = Object.keys(idx.files.files).filter(isTsFile)
  const indexed = new Set(relFiles)
  if (relFiles.length === 0) {
    langCache = { root, mtime: cacheKey, service: null, indexed }
    return null
  }

  const options = readCompilerOptions(root)
  const contents = new Map<string, string>()
  for (const rel of relFiles) {
    try {
      contents.set(absPath(root, rel), readFileSync(absPath(root, rel), 'utf8'))
    } catch {
      /* skip unreadable */
    }
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...contents.keys()],
    getScriptVersion: () => '0',
    getScriptSnapshot: (name) => {
      const text = contents.get(name)
      return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (name) => contents.has(name) || ts.sys.fileExists(name),
    readFile: (name) => contents.get(name) ?? ts.sys.readFile(name),
    readDirectory: ts.sys.readDirectory,
  }

  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  langCache = { root, mtime: cacheKey, service, indexed }
  return service
}

/** Pick the best definition for a symbol name from the index. */
export function pickDefinition(symbols: SymbolRecord[], symbol: string, fileHint?: string): SymbolRecord | null {
  const exact = symbols.filter((s) => s.n === symbol)
  if (exact.length === 0) return null
  let matches = exact
  if (fileHint) {
    const hinted = matches.filter((s) => s.f === fileHint)
    if (hinted.length > 0) matches = hinted
  }
  matches.sort((a, b) => {
    if (a.x !== b.x) return a.x ? -1 : 1
    return a.l - b.l || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0)
  })
  return matches[0] ?? null
}

function identifierOffset(sf: ts.SourceFile, line: number, name: string): number | null {
  let found: ts.Identifier | undefined
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(n) && n.text === name) {
      const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      if (pos.line + 1 === line) found = n
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found !== undefined ? found.getStart(sf) : null
}

/** Type-aware references via the TS language service. Null when unavailable. */
export function findTsReferences(
  root: string,
  idx: LoadedIndex,
  symbol: string,
  cacheKey: number,
  fileHint?: string,
): TsReference[] | null {
  const def = pickDefinition(idx.symbols.symbols, symbol, fileHint)
  if (!def || !isTsFile(def.f)) return null

  const service = getLanguageService(root, idx, cacheKey)
  if (!service) return null

  const abs = absPath(root, def.f)
  let content: string
  try {
    content = readFileSync(abs, 'utf8')
  } catch {
    return null
  }

  const sf = ts.createSourceFile(def.f, content, ts.ScriptTarget.Latest, true)
  const offset = identifierOffset(sf, def.l, def.n)
  if (offset === null) return null

  const raw = service.getReferencesAtPosition(abs, offset)
  if (!raw || raw.length === 0) return []

  const indexed = langCache?.indexed ?? new Set<string>()
  const seen = new Set<string>()
  const out: TsReference[] = []

  for (const ref of raw) {
    const rel = toRel(root, ref.fileName)
    if (!rel || !indexed.has(rel)) continue
    const snap = service.getProgram()?.getSourceFile(ref.fileName)
    if (!snap) continue
    const line = snap.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1
    const key = `${rel}:${line}:${ref.textSpan.start}`
    if (seen.has(key)) continue
    seen.add(key)
  // skip the definition site itself when it is the only entry
    out.push({ file: rel, line })
  }

  return out
}

/**
 * Type-aware references for a member/field (e.g. an interface property), seeded
 * from one real occurrence. Interface fields aren't in idx.symbols, so we jump
 * from a usage (getDefinitionAtPosition → the property declaration) and then list
 * all typed references there. Null when not TS / no seed / unresolved.
 */
export function findTsFieldReferences(
  root: string,
  idx: LoadedIndex,
  field: string,
  cacheKey: number,
  seed: { file: string; line: number },
): TsReference[] | null {
  if (!isTsFile(seed.file)) return null
  const service = getLanguageService(root, idx, cacheKey)
  if (!service) return null

  const seedAbs = absPath(root, seed.file)
  let content: string
  try {
    content = readFileSync(seedAbs, 'utf8')
  } catch {
    return null
  }
  const sf = ts.createSourceFile(seed.file, content, ts.ScriptTarget.Latest, true)
  const seedOffset = identifierOffset(sf, seed.line, field)
  if (seedOffset === null) return null

  // hop from the usage to the property declaration, then collect all typed refs there
  const decl = service.getDefinitionAtPosition(seedAbs, seedOffset)?.[0]
  if (!decl) return null
  const raw = service.getReferencesAtPosition(decl.fileName, decl.textSpan.start)
  if (!raw || raw.length === 0) return []

  const indexed = langCache?.indexed ?? new Set<string>()
  const seen = new Set<string>()
  const out: TsReference[] = []
  for (const ref of raw) {
    const rel = toRel(root, ref.fileName)
    if (!rel || !indexed.has(rel)) continue
    const snap = service.getProgram()?.getSourceFile(ref.fileName)
    if (!snap) continue
    const line = snap.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1
    const key = `${rel}:${line}:${ref.textSpan.start}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file: rel, line })
  }
  return out
}
