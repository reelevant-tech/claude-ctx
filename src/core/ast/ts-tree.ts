import ts from 'typescript'
import type { CallRef, FieldRef, SymbolNode } from '../types'

export interface TsTreeExtract {
  tree: SymbolNode[]
  calls: CallRef[]
  fields: FieldRef[]
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(mjs|cjs|js)$/.test(fileName)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function isPublicMember(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return !mods?.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  )
}

export function extractTsTree(content: string, fileName: string): TsTreeExtract {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(fileName))
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const endLineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1
  const sigOf = (n: ts.Node): string => {
    const first = n.getText(sf).split('\n')[0]!.trim()
    return first.length > 120 ? first.slice(0, 120) : first
  }
  const name = (n: { name?: ts.Node }): string =>
    n.name && (ts.isIdentifier(n.name as ts.Node) || ts.isStringLiteral(n.name as ts.Node))
      ? (n.name as ts.Identifier).text
      : ''

  const node = (n: ts.Node, k: SymbolNode['k'], nm: string, x: boolean, children?: SymbolNode[]): SymbolNode => {
    const sn: SymbolNode = { n: nm, k, l: lineOf(n), endL: endLineOf(n), x, sig: sigOf(n) }
    if (children && children.length > 0) sn.children = children
    return sn
  }

  const classMembers = (decl: ts.ClassDeclaration | ts.InterfaceDeclaration): SymbolNode[] => {
    const out: SymbolNode[] = []
    for (const m of decl.members) {
      if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) {
        out.push(node(m, 'method', name(m), isPublicMember(m)))
      } else if (
        ts.isPropertyDeclaration(m) &&
        m.initializer &&
        (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))
      ) {
        out.push(node(m, 'method', name(m), isPublicMember(m)))
      }
    }
    return out
  }

  const tree: SymbolNode[] = []
  const topLevel = (statements: ts.NodeArray<ts.Statement>, sink: SymbolNode[], exportedDefault: boolean): void => {
    for (const s of statements) {
      const x = exportedDefault || isExported(s)
      if (ts.isFunctionDeclaration(s)) sink.push(node(s, 'fn', name(s), x))
      else if (ts.isClassDeclaration(s)) sink.push(node(s, 'class', name(s), x, classMembers(s)))
      else if (ts.isInterfaceDeclaration(s)) sink.push(node(s, 'iface', name(s), x, classMembers(s)))
      else if (ts.isTypeAliasDeclaration(s)) sink.push(node(s, 'type', name(s), x))
      else if (ts.isEnumDeclaration(s)) sink.push(node(s, 'enum', name(s), x))
      else if (ts.isModuleDeclaration(s) && s.name && ts.isIdentifier(s.name)) {
        const kids: SymbolNode[] = []
        if (s.body && ts.isModuleBlock(s.body)) topLevel(s.body.statements, kids, false)
        sink.push(node(s, 'mod', s.name.text, x, kids))
      } else if (ts.isVariableStatement(s)) {
        const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0
        const vx = isExported(s)
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) {
            sink.push(node(d, isConst ? 'const' : 'var', d.name.text, vx))
          }
        }
      }
    }
  }
  topLevel(sf.statements, tree, false)

  // calls + field accesses: full walk tracking the enclosing named function/method
  const calls: CallRef[] = []
  const fields: FieldRef[] = []
  const calleeName = (expr: ts.Expression): string | null => {
    if (ts.isIdentifier(expr)) return expr.text
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text
    return null
  }
  const mkField = (field: string, line: number, kind: FieldRef['kind'], caller?: string): FieldRef =>
    caller ? { field, line, kind, caller } : { field, line, kind }
  // a member access is a write when it's the LHS of an assignment or a ++/-- target
  const isWriteTarget = (n: ts.Node): boolean => {
    const p = n.parent
    if (p && ts.isBinaryExpression(p) && p.left === n) {
      const op = p.operatorToken.kind
      return op === ts.SyntaxKind.EqualsToken || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
    }
    return p !== undefined && (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p))
  }
  const visit = (n: ts.Node, caller: string | undefined): void => {
    let next = caller
    if (ts.isFunctionDeclaration(n) && n.name) next = n.name.text
    else if ((ts.isMethodDeclaration(n) || ts.isMethodSignature(n)) && n.name && ts.isIdentifier(n.name)) next = n.name.text
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) next = n.name.text
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n.expression)
      if (callee) calls.push(caller ? { callee, line: lineOf(n), caller } : { callee, line: lineOf(n) })
    }
    // field accesses (data-flow): obj.field, obj['field'], {field: x}/{field}, const {field} = …
    if (ts.isPropertyAccessExpression(n)) {
      fields.push(mkField(n.name.text, lineOf(n), isWriteTarget(n) ? 'write' : 'read', caller))
    } else if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) {
      fields.push(mkField(n.argumentExpression.text, lineOf(n), isWriteTarget(n) ? 'write' : 'read', caller))
    } else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))) {
      fields.push(mkField(n.name.text, lineOf(n), 'write', caller))
    } else if (ts.isShorthandPropertyAssignment(n)) {
      fields.push(mkField(n.name.text, lineOf(n), 'write', caller))
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const propName = n.propertyName ?? n.name
      if (ts.isIdentifier(propName)) fields.push(mkField(propName.text, lineOf(n), 'destructure', caller))
    }
    ts.forEachChild(n, (c) => visit(c, next))
  }
  visit(sf, undefined)

  return { tree, calls, fields }
}
