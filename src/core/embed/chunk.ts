/** Build the text embedded for a file: path-as-words + exported symbols +
 * doc headings + a slice of code body (imports stripped). Kept short because
 * small sentence-transformers truncate around ~256 tokens (~1000 chars). */
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
  if (content) {
    const body = content
      .split('\n')
      .filter((l) => !/^\s*(import\b|export\s+.*\bfrom\b|use\s|pub use\s|#include|const .*require\()/.test(l))
      .join('\n')
    parts.push(body.slice(0, 800))
  }
  return parts.join('\n').slice(0, 1200)
}
