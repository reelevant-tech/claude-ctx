import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'
import type { CtxConfig } from './types'

export const DEFAULT_CONFIG: CtxConfig = {
  packBudgetTokens: 1500,
  overviewBudgetTokens: 700,
  inject: {
    sessionStart: true,
    userPromptSubmit: true,
    confidenceGate: true,
    shadow: false,
  },
  guard: {
    bash: 'warn',
    edits: 'warn',
    reads: 'warn',
  },
  exclude: [],
  riskyGlobs: [],
  secretGlobs: [],
  maxFileSizeKb: 512,
  maxFiles: 20000,
  bgIndexThresholdFiles: 2000,
  mcpMaxResultTokens: 2000,
  cochangeCommits: 1000,
  tokenAliases: {},
  relatedOnRead: true,
  cascadeReadLimit: 3,
  embeddings: {
    enabled: true,
    model: 'Xenova/all-MiniLM-L6-v2',
    weight: 0.5,
    queryPrefix: '',
    passagePrefix: '',
  },
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge: override wins; objects merge recursively; arrays/scalars replace. */
export function deepMerge<T>(base: T, override: Record<string, unknown> | null): T {
  if (!override) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k]
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

/**
 * Effective config = defaults <- ~/.claude-ctx/config.json <- <repo>/.claude-context/config.json.
 * Unknown keys are carried along harmlessly; malformed files are ignored (fail-open).
 */
export function loadConfig(repoRoot?: string): CtxConfig {
  let cfg = DEFAULT_CONFIG
  cfg = deepMerge(cfg, readJsonIfExists(join(dataDir(), 'config.json')))
  if (repoRoot) {
    cfg = deepMerge(cfg, readJsonIfExists(join(repoRoot, '.claude-context', 'config.json')))
  }
  return cfg
}
