import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildIndex } from '../../core/indexer/index'
import { INFRA_GLOBS } from '../../core/indexer/risk'
import { loadIndex } from '../../core/store/shards'
import { renderManagedBlock, upsertManagedBlock } from '../../installer/claude-md'
import { out, parseCommon } from '../shared'

export async function run(argv: string[]): Promise<number> {
  const a = parseCommon(argv, { rules: { type: 'boolean' } })
  let idx = loadIndex(a.repo)
  if (!idx) {
    buildIndex(a.repo, { mode: 'full' })
    idx = loadIndex(a.repo)
  }
  if (!idx) {
    process.stderr.write('Failed to build index.\n')
    return 1
  }

  const claudeMd = join(a.repo, 'CLAUDE.md')
  const existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : null
  const block = renderManagedBlock(idx)
  writeFileSync(claudeMd, upsertManagedBlock(existing, block))
  out(`Updated ${claudeMd} (managed claude-ctx block)`)

  if (a.values.rules === true) {
    const rulesDir = join(a.repo, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    const genGlobs = ['dist/**', 'build/**', 'target/**', '**/*.gen.*', '**/*.min.js', '**/*lock*']
    const gen = [
      '---',
      'paths:',
      ...genGlobs.map((g) => `  - "${g}"`),
      '---',
      '',
      '# Generated files',
      '',
      'These files are generated and will be overwritten. Do not edit them directly — change the source generator instead.',
      '',
    ].join('\n')
    writeFileSync(join(rulesDir, 'ctx-generated.md'), gen)
    const infra = [
      '---',
      'paths:',
      ...INFRA_GLOBS.slice(0, 12).map((g) => `  - "${g}"`),
      '---',
      '',
      '# Infrastructure / production-sensitive files',
      '',
      'Changes here affect deployments, infrastructure, or the database. Confirm with the user before editing, and double-check the blast radius.',
      '',
    ].join('\n')
    writeFileSync(join(rulesDir, 'ctx-infra.md'), infra)
    out(`Wrote ${rulesDir}/ctx-generated.md and ctx-infra.md`)
  }
  return 0
}
