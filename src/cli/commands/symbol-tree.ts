import { renderSymbolTree } from '../../core/ast/render'
import { toRepoRelative } from '../../core/paths'
import { loadShard } from '../../core/store/shards'
import type { SymbolTreeShard } from '../../core/types'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv)
  const arg = a.positionals[0]
  if (!arg) {
    process.stderr.write('Usage: ctx symbol_tree <file>\n')
    return 1
  }
  const rel = toRepoRelative(a.repo, arg)
  if (rel === null) {
    out(`Path outside repo: ${arg}`)
    return 0
  }
  const shard = loadShard<SymbolTreeShard>(a.repo, 'symtree')
  if (!shard) {
    process.stderr.write('No symbol trees. Run: ctx index\n')
    process.exitCode = 1
    return 1
  }
  const tree = shard.trees[rel]
  if (!tree || tree.length === 0) {
    out(`No symbol tree for ${rel} (parser: ${shard.parsers[rel] ?? 'none'}).`)
    return 0
  }
  if (a.json) {
    out(JSON.stringify(tree, null, 2))
    return 0
  }
  out(`${rel} (${shard.parsers[rel] ?? 'none'}):`)
  out(renderSymbolTree(tree))
  return 0
}
