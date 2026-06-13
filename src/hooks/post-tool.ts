import { loadConfig } from '../core/config'
import { broadDiscoveryVerdict } from '../core/guard/bash'
import { appendEvent } from '../core/memory/log'
import { bumpRead, loadState, markRelatedShown, recordEdit, recordIndexQuery } from '../core/memory/state'
import { findRepoRoot, toRepoRelative } from '../core/paths'
import { requestIndexRefresh, cliJsPath } from '../core/indexer/spawn'
import { relatedFiles } from '../core/related'
import { appendPending, loadMeta, loadShard } from '../core/store/shards'
import type { FilesShard, GitShard, GraphShard, HookInput, HookOutput } from '../core/types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Auto-expand: after reading an indexed file, surface its neighbourhood so the
 * model gets structure without cascading. Loads only files+graph+git (no
 * symbols/vectors/parser) — hook-bundle-safe. Once per file per session. */
function relatedContext(root: string, sid: string, rel: string): string | null {
  const files = loadShard<FilesShard>(root, 'files')
  if (!files || !files.files[rel]) return null
  const graph = loadShard<GraphShard>(root, 'graph') ?? { fwd: {}, rev: {}, centrality: {} }
  const git = loadShard<GitShard>(root, 'git') ?? { recent: [], churn: {}, cochange: {} }
  const g = relatedFiles({ files, graph, git }, rel)
  const parts: string[] = []
  const add = (label: string, items: string[]) => {
    if (items.length > 0) parts.push(`${label}: ${items.slice(0, 6).join(', ')}`)
  }
  add('imports', g.imports)
  add('imported by', g.importedBy)
  add('tests', g.tests)
  add('co-changed', g.coChanged)
  if (parts.length === 0) return null
  markRelatedShown(root, sid, rel)
  return `[claude-ctx] Related to ${rel} — ${parts.join('; ')}. Prefer mcp__ctx__trace_symbol / references / related_files over grepping or reading files one-by-one.`
}

function discoveryNudge(root: string, command: string): string | null {
  const meta = loadMeta(root)
  const verdict = broadDiscoveryVerdict(command, {
    repoRoot: root,
    secretGlobs: meta?.secretGlobs ?? [],
    riskyGlobs: meta?.riskyGlobs ?? [],
  })
  if (!verdict) return null
  const hint = verdict.suggestion ? ` ${verdict.suggestion}` : ''
  return `[claude-ctx] Shell discovery (${verdict.rule}: ${verdict.reason}) — the repo is indexed.${hint}`
}

export async function handle(input: HookInput): Promise<HookOutput> {
  // memory is always on (no config gate)
  const root = findRepoRoot(input.cwd ?? process.cwd()).root
  const sid = input.session_id ?? 'unknown'
  const tool = input.tool_name ?? ''
  const now = Math.floor(Date.now() / 1000)
  const ti = input.tool_input ?? {}

  try {
    // index query (context_pack/symbol_search/related_files/dep_trace/…) — the
    // model is using the index, so reset the manual-read streak and log it.
    if (tool.startsWith('mcp__ctx__')) {
      recordIndexQuery(root, sid)
      appendEvent(root, sid, { ts: now, e: 'mcp', tool })
      return {}
    }
    if (tool === 'Read') {
      const rel = typeof ti.file_path === 'string' ? toRepoRelative(root, ti.file_path) : null
      if (rel !== null) {
        bumpRead(root, sid, rel)
        appendEvent(root, sid, { ts: now, e: 'read', f: rel })
        const cfg = loadConfig(root)
        if (cfg.relatedOnRead !== false && !(loadState(root, sid).relatedShown ?? []).includes(rel)) {
          const ctx = relatedContext(root, sid, rel)
          if (ctx) {
            return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } }
          }
        }
      }
    } else if (EDIT_TOOLS.has(tool)) {
      const rel = typeof ti.file_path === 'string' ? toRepoRelative(root, ti.file_path) : null
      if (rel !== null) {
        recordEdit(root, sid, rel)
        appendEvent(root, sid, { ts: now, e: 'edit', f: rel, tool })
        appendPending(root, [rel])
        requestIndexRefresh(root, cliJsPath())
      }
    } else if (tool === 'Bash') {
      const cmd = String(ti.command ?? '')
      if (cmd) {
        appendEvent(root, sid, { ts: now, e: 'bash', cmd: cmd.slice(0, 200) })
        const nudge = discoveryNudge(root, cmd)
        if (nudge) {
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge } }
        }
      }
    }
  } catch {
    /* memory is best-effort */
  }
  return {}
}
