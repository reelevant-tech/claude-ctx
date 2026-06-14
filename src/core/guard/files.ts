/**
 * Edit-target policy and read-value warnings.
 *
 * NOTE: the glob lists below intentionally duplicate (a minimal subset of)
 * src/core/indexer/risk.ts. That module is developed concurrently by another
 * workstream; guards must stay decoupled and keep working with no index at
 * all (record === null), so we do not import it.
 */
import { posix } from 'node:path'
import picomatch from 'picomatch'
import type { CtxConfig, FileRecord, GuardVerdict } from '../types'

const SECRET_BASENAME_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*_rsa*',
  'credentials*',
  '*.tfvars',
  '.npmrc',
  '.netrc',
]
const isSecretBasename = picomatch(SECRET_BASENAME_GLOBS, { dot: true })

const GENERATED_GLOBS = [
  'dist/**',
  '**/dist/**',
  'target/**',
  '**/target/**',
  '*.min.js',
  '**/*.min.js',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
]
const isGenerated = picomatch(GENERATED_GLOBS, { dot: true })

const VENDOR_GLOBS = [
  'node_modules/**',
  '**/node_modules/**',
  'vendor/**',
  '**/vendor/**',
  'third_party/**',
  '**/third_party/**',
]
const isVendor = picomatch(VENDOR_GLOBS, { dot: true })

const INFRA_GLOBS = [
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*',
  '**/docker-compose*',
  '*.tf',
  '**/*.tf',
  '*.tfstate',
  '**/*.tfstate',
  '.github/workflows/**',
  'k8s/**',
  '**/k8s/**',
  'helm/**',
  '**/helm/**',
  'terraform/**',
  'ansible/**',
]
const INFRA_MATCHERS = INFRA_GLOBS.map((glob) => ({ glob, match: picomatch(glob, { dot: true }) }))

function norm(p: string): string {
  let out = p.replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out.replace(/^\/+/, '')
}

/**
 * Is this path a credentials/secret file? Shared by the edit guard and the read
 * guard so both block the exact same set (record tag, known basenames, or the
 * user's secretGlobs). Works with no index (record === null).
 */
export function isSecretTarget(relPath: string, record: FileRecord | null, cfg: CtxConfig): boolean {
  const p = norm(relPath)
  const base = posix.basename(p)
  const extraSecret = cfg.secretGlobs.length > 0 ? picomatch(cfg.secretGlobs, { dot: true }) : null
  return (
    record?.kind === 'secret' ||
    record?.risk.includes('secret') ||
    isSecretBasename(base) ||
    (extraSecret !== null && (extraSecret(p) || extraSecret(base))) ||
    false
  )
}

export function classifyEditTarget(
  relPath: string,
  record: FileRecord | null,
  cfg: CtxConfig,
): GuardVerdict | null {
  const p = norm(relPath)
  const base = posix.basename(p)

  if (isSecretTarget(relPath, record, cfg)) {
    return { tier: 'severe', rule: 'edit-secret', reason: 'credentials file' }
  }

  if (
    record?.kind === 'generated' ||
    record?.risk.includes('generated') ||
    isGenerated(p) ||
    isGenerated(base)
  ) {
    return {
      tier: 'destructive',
      rule: 'edit-generated',
      reason: 'generated file — edits will be overwritten; edit the source generator instead',
    }
  }

  if (record?.kind === 'vendor' || record?.risk.includes('vendor') || isVendor(p)) {
    return {
      tier: 'destructive',
      rule: 'edit-vendor',
      reason: 'vendored dependency — changes are lost on the next install',
    }
  }

  if (record?.kind === 'infra' || record?.risk.includes('infra')) {
    return {
      tier: 'destructive',
      rule: 'edit-infra',
      reason: 'production-sensitive file (risk tag)',
    }
  }
  for (const { glob, match } of INFRA_MATCHERS) {
    if (match(p) || match(base)) {
      return {
        tier: 'destructive',
        rule: 'edit-infra',
        reason: `production-sensitive file (${glob})`,
      }
    }
  }
  if (cfg.riskyGlobs.length > 0) {
    const risky = picomatch(cfg.riskyGlobs, { dot: true })
    if (risky(p) || risky(base)) {
      return {
        tier: 'destructive',
        rule: 'edit-infra',
        reason: 'production-sensitive file (config riskyGlobs)',
      }
    }
  }

  return null
}

export function readWarning(
  relPath: string,
  record: FileRecord | null,
  readCount: number,
): string | null {
  const p = norm(relPath)
  const base = posix.basename(p)
  const lowValue =
    record?.kind === 'generated' ||
    record?.kind === 'vendor' ||
    record?.risk.includes('generated') ||
    record?.risk.includes('vendor') ||
    isGenerated(p) ||
    isGenerated(base) ||
    isVendor(p)
  if (lowValue) return 'low-value read: generated file — usually safe to skip'
  if (record && record.lines > 3000) {
    return `huge file (${record.lines} lines) — consider mcp__ctx__symbol_search to find the relevant section`
  }
  if (readCount >= 2) {
    return `already read ${readCount} times this session — content unchanged unless edited`
  }
  return null
}
