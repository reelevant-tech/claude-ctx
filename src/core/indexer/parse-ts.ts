import ts from 'typescript'
import type { ParseResult, ParsedSymbol, SymbolKind } from '../types'

// Larger files fall back to the lexical parser (caller catches this error).
const MAX_PARSE_CHARS = 1_500_000
const SIG_MAX = 120

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/** Parse-only TS/JS extraction: top-level statements, no type checking, no body recursion. */
export function parseTs(content: string, fileName: string): ParseResult {
  if (content.length > MAX_PARSE_CHARS) throw new Error('file too large')

  const sf = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(fileName),
  )

  const symbols: ParsedSymbol[] = []
  const imports: string[] = []
  const exports: string[] = []
  // local names exported later via a bare `export { ... }` statement
  const laterExported = new Set<string>()

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1

  const firstLine = (node: ts.Node): string => {
    const text = content.slice(node.getStart(sf), node.end)
    const head = text.split('\n', 1)[0] ?? text
    return head.trim().slice(0, SIG_MAX)
  }

  const hasMod = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
    return mods !== undefined && mods.some((m) => m.kind === kind)
  }

  const collectCallImports = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      const callee = node.expression
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const isDynImport = callee.kind === ts.SyntaxKind.ImportKeyword
      if ((isRequire || isDynImport) && arg !== undefined && ts.isStringLiteral(arg)) {
        imports.push(arg.text)
      }
    }
    node.forEachChild(collectCallImports)
  }

  const addSymbol = (node: ts.Node, name: string | undefined, k: SymbolKind): void => {
    const exported = hasMod(node, ts.SyntaxKind.ExportKeyword)
    const isDefault = hasMod(node, ts.SyntaxKind.DefaultKeyword)
    const n = name ?? (isDefault ? 'default' : undefined)
    if (n === undefined) return
    symbols.push({ n, k, l: lineOf(node.getStart(sf)), x: exported, sig: firstLine(node) })
    if (exported) exports.push(isDefault ? 'default' : n)
  }

  for (const stmt of sf.statements) {
    // fail open: a malformed statement from the error-tolerant parser must not kill the file
    try {
      if (ts.isImportDeclaration(stmt)) {
        if (ts.isStringLiteral(stmt.moduleSpecifier)) imports.push(stmt.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(stmt)) {
        const isReexport = stmt.moduleSpecifier !== undefined
        if (stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)) {
          imports.push(stmt.moduleSpecifier.text)
        }
        const clause = stmt.exportClause
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const el of clause.elements) {
            exports.push(el.name.text)
            if (!isReexport) laterExported.add((el.propertyName ?? el.name).text)
          }
        } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
          exports.push(clause.name.text)
        }
      } else if (ts.isImportEqualsDeclaration(stmt)) {
        const ref = stmt.moduleReference
        if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
          imports.push(ref.expression.text)
        }
      } else if (ts.isExportAssignment(stmt)) {
        exports.push('default')
      } else if (ts.isFunctionDeclaration(stmt)) {
        addSymbol(stmt, stmt.name?.text, 'fn')
      } else if (ts.isClassDeclaration(stmt)) {
        addSymbol(stmt, stmt.name?.text, 'class')
      } else if (ts.isInterfaceDeclaration(stmt)) {
        addSymbol(stmt, stmt.name.text, 'iface')
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        addSymbol(stmt, stmt.name.text, 'type')
      } else if (ts.isEnumDeclaration(stmt)) {
        addSymbol(stmt, stmt.name.text, 'enum')
      } else if (ts.isVariableStatement(stmt)) {
        const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
        const k: SymbolKind = isConst ? 'const' : 'var'
        const exported = hasMod(stmt, ts.SyntaxKind.ExportKeyword)
        const sig = firstLine(stmt)
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue // skip destructuring patterns
          symbols.push({ n: decl.name.text, k, l: lineOf(decl.getStart(sf)), x: exported, sig })
          if (exported) exports.push(decl.name.text)
        }
        collectCallImports(stmt)
      }
    } catch {
      // skip broken statement, keep the rest
    }
  }

  for (const s of symbols) if (laterExported.has(s.n)) s.x = true

  return {
    symbols,
    imports: dedupe(imports),
    exports: dedupe(exports),
    docHeadings: [],
  }
}
