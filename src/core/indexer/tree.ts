/**
 * Compact, deterministic repo tree summary for SessionStart/overview injection.
 * Groups files by their top two directory levels with per-dir counts and a few
 * notable entries; capped to maxLines lines, each <= 100 chars.
 */
export function buildTreeSummary(files: { rel: string }[], maxLines = 60): string {
  // group by first-level dir ('' = repo root), then list second-level subdirs
  interface DirNode {
    files: string[] // basenames of files directly in this dir
    subdirs: Map<string, string[]> // subdir name -> basenames directly under it
    total: number
  }
  const top = new Map<string, DirNode>()

  const getNode = (key: string): DirNode => {
    let n = top.get(key)
    if (!n) {
      n = { files: [], subdirs: new Map(), total: 0 }
      top.set(key, n)
    }
    return n
  }

  for (const { rel } of files) {
    const parts = rel.split('/')
    if (parts.length === 1) {
      const node = getNode('')
      node.files.push(parts[0]!)
      node.total++
    } else {
      const l1 = parts[0]!
      const node = getNode(l1)
      node.total++
      if (parts.length === 2) {
        node.files.push(parts[1]!)
      } else {
        const l2 = parts[1]!
        const sub = node.subdirs.get(l2) ?? []
        sub.push(parts.slice(2).join('/'))
        node.subdirs.set(l2, sub)
      }
    }
  }

  const lines: string[] = []
  const clip = (s: string): string => (s.length > 100 ? `${s.slice(0, 97)}...` : s)
  const notable = (names: string[], n: number): string => {
    const sorted = [...names].sort()
    const shown = sorted.slice(0, n)
    const more = sorted.length - shown.length
    return shown.join(', ') + (more > 0 ? `, ...${more} more` : '')
  }

  // root files first, then dirs by descending file count then name
  const rootNode = top.get('')
  if (rootNode && rootNode.files.length > 0) {
    lines.push(clip(`./ — ${notable(rootNode.files, 6)}`))
  }
  const dirs = [...top.entries()]
    .filter(([k]) => k !== '')
    .sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1))

  for (const [name, node] of dirs) {
    if (lines.length >= maxLines) break
    lines.push(clip(`${name}/ (${node.total} files)`))
    // direct files in the level-1 dir
    if (node.files.length > 0 && lines.length < maxLines) {
      lines.push(clip(`  ${notable(node.files, 8)}`))
    }
    // level-2 subdirs by count
    const subs = [...node.subdirs.entries()].sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
    )
    for (const [sub, names] of subs) {
      if (lines.length >= maxLines) break
      lines.push(clip(`  ${sub}/ (${names.length}): ${notable(names, 4)}`))
    }
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n')
  }
  return lines.join('\n')
}
