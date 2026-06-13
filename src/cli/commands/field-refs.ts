import { fieldRefs, renderFieldRefs } from '../../core/trace/field-refs'
import { out, parseCommon, requireIndex } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { file: { type: 'string' } })
  const idx = requireIndex(a.repo)
  if (!idx) return 1
  const field = a.positionals.join(' ').trim()
  if (!field) {
    process.stderr.write('Usage: ctx field-refs <field> [--file <path>]\n')
    return 1
  }
  const file = typeof a.values.file === 'string' ? a.values.file : undefined
  const r = fieldRefs(a.repo, idx, field, { file })
  if (!r) {
    out(`No field accesses indexed for "${field}".`)
    return 0
  }
  if (a.json) {
    out(JSON.stringify(r, null, 2))
    return 0
  }
  out(renderFieldRefs(r))
  return 0
}
