import type { SymbolNode } from '../types'

/** Build the text embedded for a whole file: path-as-words + exported symbols +
 * doc headings + a slice of code body (imports stripped). Used for the
 * file-level chunk and as the fallback when no symbol tree is available. */
export function fileEmbeddingText(
  rel: string,
  exportsArr: string[],
  docHeadings: string[],
  content: string | null,
): string {
  const parts: string[] = []
  parts.push(rel.replace(/[/_.\-]+/g, ' '))
  if (exportsArr.length > 0) parts.push(exportsArr.slice(0, 20).join(' '))
  if (docHeadings.length > 0) parts.push(docHeadings.slice(0, 10).join(' '))
  if (content) parts.push(stripImports(content).slice(0, 800))
  return parts.join('\n').slice(0, 1200)
}

/** Build the text embedded for a single symbol: path words + parent chain +
 * kind/name + the symbol's source span (bounded). Front-loads identifiers so a
 * small sentence model anchors on them. */
export function symbolChunkText(
  rel: string,
  parentChain: string[],
  node: SymbolNode,
  fileLines: string[],
): string {
  const parts: string[] = []
  parts.push(rel.replace(/[/_.\-]+/g, ' '))
  const heading = [...parentChain, `${node.k} ${node.n}`].filter(Boolean).join(' ')
  parts.push(heading)
  const body = fileLines.slice(node.l - 1, node.endL).join('\n')
  parts.push(body.slice(0, 1000))
  return parts.join('\n').slice(0, 1400)
}

/** A symbol worth its own vector + the parent names leading to it. Flattens the
 * tree; containers (impl/class/mod) yield a chunk AND recurse into children. */
export interface FlatSymbol {
  node: SymbolNode
  parentChain: string[]
}
export function flattenForChunks(nodes: SymbolNode[], parents: string[] = [], out: FlatSymbol[] = []): FlatSymbol[] {
  for (const n of nodes) {
    out.push({ node: n, parentChain: parents })
    if (n.children && n.children.length > 0) {
      flattenForChunks(n.children, [...parents, n.n].filter(Boolean), out)
    }
  }
  return out
}

function stripImports(content: string): string {
  return content
    .split('\n')
    .filter((l) => !/^\s*(import\b|export\s+.*\bfrom\b|use\s|pub use\s|#include|const .*require\()/.test(l))
    .join('\n')
}
