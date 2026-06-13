import { findTsFieldReferences } from '../ast/ts-refs'
import { loadShard, shardMtimeMs } from '../store/shards'
import type { FieldAccessShard, FieldRef, LoadedIndex } from '../types'

/** A field access with its file (the shard keys by file; render needs it per-site). */
export interface FieldSite {
  file: string
  line: number
  kind: FieldRef['kind'] | 'ref'
  caller?: string
}

export interface FieldRefsResult {
  field: string
  /** name-based = all same-named sites (complete); typed = narrowed to one property declaration */
  source: 'name-based' | 'typed'
  sites: FieldSite[]
  files: number
  /** total name-based occurrences (so the model sees when typed narrowed a subset) */
  nameTotal: number
}

const COMMON_FILE_THRESHOLD = 8

/**
 * Read/write/destructure sites of a member/field.
 *
 * Default is the COMPLETE name-based view — a field keeps its *name* across a
 * serialization boundary (JSON.stringify→parse) even when the type identity is
 * broken, so showing every same-named site is what actually reveals the data flow.
 * Only when a name is common enough to be noisy (spans ≥8 files) do we use the TS
 * type system to narrow to a single property declaration and cut collisions.
 */
export function fieldRefs(
  root: string,
  idx: LoadedIndex,
  field: string,
  opts?: { file?: string },
): FieldRefsResult | null {
  const name = field.trim()
  if (!name) return null
  const shard = loadShard<FieldAccessShard>(root, 'fieldaccess')
  if (!shard) return null

  const nameSites: FieldSite[] = []
  for (const f of Object.keys(shard.fieldAccesses)) {
    if (opts?.file && f !== opts.file) continue
    for (const r of shard.fieldAccesses[f]!) {
      if (r.field === name) nameSites.push({ file: f, line: r.line, kind: r.kind, caller: r.caller })
    }
  }
  if (nameSites.length === 0) return null
  const nameFiles = new Set(nameSites.map((s) => s.file)).size

  // Noisy common name → try to narrow to the real property via the type system.
  if (nameFiles >= COMMON_FILE_THRESHOLD) {
    const typed = resolveTyped(root, idx, name, nameSites, opts?.file)
    if (typed && typed.length > 0) {
      const roleAt = new Map<string, FieldSite>()
      for (const s of nameSites) roleAt.set(`${s.file}:${s.line}`, s)
      const sites = typed.map((t) => roleAt.get(t) ?? { file: t.split(':')[0]!, line: Number(t.split(':')[1]), kind: 'ref' as const })
      const tFiles = new Set(sites.map((s) => s.file)).size
      if (tFiles < nameFiles) {
        return { field: name, source: 'typed', sites, files: tFiles, nameTotal: nameSites.length }
      }
    }
  }

  return { field: name, source: 'name-based', sites: nameSites, files: nameFiles, nameTotal: nameSites.length }
}

/** Read-seeded typed resolution; returns `file:line` keys of the widest typed result. */
function resolveTyped(
  root: string,
  idx: LoadedIndex,
  name: string,
  nameSites: FieldSite[],
  fileHint?: string,
): string[] | null {
  const cacheKey = shardMtimeMs(root, 'meta') ?? idx.meta.indexedAt
  const rank = (k: FieldSite['kind']): number => (k === 'read' ? 0 : k === 'destructure' ? 1 : 2)
  const seeds = [...nameSites].sort((a, b) => {
    if (fileHint) {
      const af = a.file === fileHint ? 0 : 1
      const bf = b.file === fileHint ? 0 : 1
      if (af !== bf) return af - bf
    }
    return rank(a.kind) - rank(b.kind)
  })
  let best: string[] | null = null
  const tried = new Set<string>()
  for (const s of seeds) {
    const k = `${s.file}:${s.line}`
    if (tried.has(k)) continue
    tried.add(k)
    if (tried.size > 5) break
    const t = findTsFieldReferences(root, idx, name, cacheKey, { file: s.file, line: s.line })
    if (t) {
      const keys = t.map((r) => `${r.file}:${r.line}`)
      if (!best || keys.length > best.length) best = keys
    }
    if (best && best.length >= nameSites.length) break
  }
  return best
}

export function renderFieldRefs(r: FieldRefsResult): string {
  const writes = r.sites.filter((s) => s.kind === 'write')
  const reads = r.sites.filter((s) => s.kind === 'read' || s.kind === 'ref')
  const destr = r.sites.filter((s) => s.kind === 'destructure')
  const note =
    r.source === 'typed'
      ? 'typed (narrowed to one property via the TS type system)'
      : 'name-based (all same-named sites — complete data-flow view)'
  const fileWord = `${r.files} file${r.files === 1 ? '' : 's'}`
  const lines = [`## field: ${r.field} — ${note} · ${r.sites.length} site${r.sites.length === 1 ? '' : 's'} across ${fileWord}`]
  if (r.source === 'typed' && r.nameTotal > r.sites.length) {
    lines.push(`_Name appears at ${r.nameTotal} sites total; ${r.sites.length} resolved to this declaration (the rest are different objects with the same field name)._`)
  } else if (r.source === 'name-based' && r.files >= COMMON_FILE_THRESHOLD) {
    lines.push(`_Common field name (${fileWord}); could not narrow by type — may include unrelated objects. Pass file:"<path>" to disambiguate._`)
  }
  const section = (label: string, arr: FieldSite[]): void => {
    if (arr.length === 0) return
    lines.push(`**${label}** (${arr.length}):`)
    for (const s of arr) lines.push(`  ${s.file}:${s.line}${s.caller ? `  in ${s.caller}()` : ''}`)
  }
  section('Writes', writes)
  section('Reads', reads)
  section('Destructure', destr)
  lines.push(
    '_Data-flow view; no write↔read link is asserted across serialization boundaries. Symbol-level: mcp__ctx__trace_symbol · mcp__ctx__references._',
  )
  return lines.join('\n')
}
