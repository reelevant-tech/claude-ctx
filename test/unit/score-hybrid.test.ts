import { describe, expect, it } from 'vitest'
import { scoreFiles } from '../../src/core/router/score'
import { tokenizeTask } from '../../src/core/tokens'
import type { FileRecord, LoadedIndex } from '../../src/core/types'

function rec(over: Partial<FileRecord> = {}): FileRecord {
  return {
    h: 'h', mtime: 0, size: 0, lines: 10, lang: 'ts', pkg: -1, parser: 'ts-api',
    kind: 'source', risk: [], entry: false, exports: [], externalDeps: [], docHeadings: [],
    tests: [], ...over,
  }
}

function makeIndex(): LoadedIndex {
  const files: Record<string, FileRecord> = {
    // lexical match for "auth"
    'src/auth.ts': rec({ exports: ['authenticate'] }),
    // NO lexical overlap with "authentication" — only semantic can surface it
    'src/session_guard.ts': rec({ exports: ['verifyCredentials'] }),
    'src/unrelated.ts': rec({ exports: ['pancakeRecipe'] }),
  }
  return {
    meta: { version: 1, root: '/r', repoId: 'r', indexedAt: 0, indexDurationMs: 0, fileCount: 3, skippedCount: 0, isGit: false, projectType: 'ts-app', packages: [], treeSummary: '', riskyGlobs: [], secretGlobs: [] },
    files: { files },
    symbols: { symbols: [], tokenIndex: {} },
    graph: { fwd: {}, rev: {}, centrality: {} },
    git: { recent: [], churn: {}, cochange: {} },
    commands: { commands: [] },
  }
}

describe('hybrid scoring', () => {
  it('without semantic, a paraphrase-only file is not surfaced', () => {
    const idx = makeIndex()
    const scored = scoreFiles(tokenizeTask('fix auth flow'), idx, null, 0)
    const paths = scored.map((s) => s.path)
    expect(paths).toContain('src/auth.ts')
    expect(paths).not.toContain('src/session_guard.ts')
  })

  it('with a semantic map, a high-cosine paraphrase file IS surfaced with a reason', () => {
    const idx = makeIndex()
    const semantic = new Map<string, number>([
      ['src/auth.ts', 0.5],
      ['src/session_guard.ts', 0.7], // strongly similar, no lexical overlap
      ['src/unrelated.ts', 0.05],
    ])
    const scored = scoreFiles(tokenizeTask('fix auth flow'), idx, null, 0, semantic, 0.6)
    const guard = scored.find((s) => s.path === 'src/session_guard.ts')
    expect(guard).toBeTruthy()
    expect(guard!.reasons.some((r) => r.reason.includes('semantically similar'))).toBe(true)
    // weakly-similar unrelated file stays out
    expect(scored.map((s) => s.path)).not.toContain('src/unrelated.ts')
  })

  it('passing no semantic map is identical to the legacy 4-arg call', () => {
    const idx = makeIndex()
    const tokens = tokenizeTask('fix auth flow')
    const a = scoreFiles(tokens, idx, null, 0)
    const b = scoreFiles(tokens, idx, null, 0, undefined)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
