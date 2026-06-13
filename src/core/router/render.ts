import { basename } from 'node:path'
import { estimateTokens } from '../tokens'
import type { ContextPack, LoadedIndex, RepoSummary } from '../types'

const MORE_LINE = '_More: mcp__ctx__context_pack, symbol_search, related_files, dep_trace_'

export function renderPack(pack: ContextPack): string {
  const lines: string[] = []
  const task = pack.task.length > 80 ? `${pack.task.slice(0, 77)}...` : pack.task
  lines.push(`## Repo context for: "${task}" (confidence: ${pack.confidence})`)
  if (pack.files.length > 0) {
    lines.push('**Likely relevant files:**')
    for (const f of pack.files) {
      let line = `- ${f.path} — ${f.why.join('; ')}`
      if (f.tests.length > 0) {
        const shown = f.tests.slice(0, 3).join(', ')
        const more = f.tests.length > 3 ? ` +${f.tests.length - 3} more` : ''
        line += ` (tests: ${shown}${more})`
      }
      if (f.risk.length > 0) line += ` [${f.risk.join(', ')}]`
      lines.push(line)
    }
  }
  const syms = pack.files.flatMap((f) => f.symbols).slice(0, 8)
  if (syms.length > 0) lines.push(`**Key symbols:** ${syms.join('; ')}`)
  if (pack.depLinks.length > 0) lines.push(`**Deps:** ${pack.depLinks.join('; ')}`)
  for (const ex of pack.excerpts) {
    lines.push(`**Excerpt ${ex.path}:${ex.lines}:**`, '```', ex.text, '```')
  }
  if (pack.missing !== undefined) lines.push(`**Missing:** ${pack.missing}`)
  if (pack.nextStep !== undefined) lines.push(`**Next:** ${pack.nextStep}`)
  if (pack.alreadyInspected.length > 0) {
    lines.push(`Already inspected: ${pack.alreadyInspected.join(', ')}`)
  }
  lines.push(MORE_LINE)
  return lines.join('\n')
}

const RULES_DIGEST = [
  '**Rules:**',
  '- Consult this map before exploring.',
  '- Call mcp__ctx__context_pack with your task before multi-file work.',
  '- Prefer mcp__ctx__symbol_search / related_files over repo-wide grep.',
  '- Check related tests before editing (mcp__ctx__find_tests).',
  '- Avoid generated/vendor paths; record decisions with mcp__ctx__session_note.',
]

export function renderOverview(
  idx: LoadedIndex,
  summary: RepoSummary | null,
  budgetTokens: number,
  opts?: { compactRecap?: boolean },
): string {
  const meta = idx.meta
  const building = meta.partial ? ', index building...' : ''
  const repoLine = `## Repo: ${basename(meta.root)} (${meta.projectType}, ${meta.fileCount} files${building})`
  const last = summary?.sessions[0]

  if (opts?.compactRecap) {
    const limit = Math.min(150, budgetTokens)
    const lines = [repoLine, ...RULES_DIGEST]
    if (last) {
      const t = last.task.length > 120 ? `${last.task.slice(0, 117)}...` : last.task
      lines.push(`**Last session:** ${t}`)
    }
    while (estimateTokens(lines.join('\n')) > limit && lines.length > 1) lines.pop()
    return lines.join('\n')
  }

  const pkgLine: string[] = []
  const pkgs = meta.packages.slice(0, 8)
  if (pkgs.length > 0) {
    pkgLine.push(`**Packages:** ${pkgs.map((p) => `${p.name} (${p.dir || '.'}, ${p.kind})`).join('; ')}`)
  }

  const entries: string[] = []
  for (const p of meta.packages) {
    for (const e of p.entrypoints) if (!entries.includes(e) && entries.length < 6) entries.push(e)
  }
  for (const f of Object.keys(idx.files.files).sort()) {
    const rec = idx.files.files[f]
    if (rec?.entry && !entries.includes(f) && entries.length < 6) entries.push(f)
  }
  const entryLine: string[] = entries.length > 0 ? [`**Entrypoints:** ${entries.join(', ')}`] : []

  const cmds = idx.commands.commands.slice(0, 6)
  const cmdLines: string[] =
    cmds.length > 0 ? ['**Commands:**', ...cmds.map((c) => `- ${c.cmd} [${c.kind}]`)] : []

  let treeLines = meta.treeSummary ? meta.treeSummary.split('\n').filter((l) => l.length > 0) : []

  const sessionLines: string[] = []
  if (last) {
    sessionLines.push(`**Last session:** ${last.task}`)
    if (last.filesEdited.length > 0) {
      sessionLines.push(`Edited: ${last.filesEdited.slice(0, 6).join(', ')}`)
    }
    for (const n of last.notes.slice(0, 8)) sessionLines.push(`Note: ${n}`)
    while (sessionLines.length > 10) sessionLines.pop()
  }

  const rules = [...RULES_DIGEST]
  const assemble = (): string => {
    const parts = [repoLine, ...pkgLine, ...entryLine, ...cmdLines]
    if (treeLines.length > 0) parts.push('**Tree:**', '```', ...treeLines, '```')
    parts.push(...rules, ...sessionLines)
    return parts.join('\n')
  }

  // shrink/drop from the end: tree lines first, then whole sections
  let out = assemble()
  while (estimateTokens(out) > budgetTokens) {
    if (treeLines.length > 0) treeLines = treeLines.slice(0, -1)
    else if (cmdLines.length > 0) cmdLines.length = 0
    else if (sessionLines.length > 0) sessionLines.pop()
    else if (entryLine.length > 0) entryLine.length = 0
    else if (pkgLine.length > 0) pkgLine.length = 0
    else if (rules.length > 0) rules.pop()
    else break
    out = assemble()
  }
  return out
}
