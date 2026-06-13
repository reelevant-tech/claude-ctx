import picomatch from 'picomatch'
import type { CtxConfig, FileKind, RiskTag } from '../types'

export const SECRET_GLOBS: string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*_rsa*',
  '**/*.p12',
  '**/*.pfx',
  '**/credentials*',
  '**/secrets*',
  '**/secret*',
  '**/.npmrc',
  '**/.netrc',
  '**/*.tfvars',
  '**/service-account*.json',
  '**/.aws/**',
]

export const GENERATED_GLOBS: string[] = [
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.gen.*',
  '**/*_generated.*',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.snap',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/*.map',
]

export const VENDOR_GLOBS: string[] = ['**/vendor/**', '**/third_party/**', '**/node_modules/**']

export const INFRA_GLOBS: string[] = [
  '**/Dockerfile*',
  '**/docker-compose*',
  '**/*.tf',
  '**/terraform/**',
  '**/k8s/**',
  '**/kubernetes/**',
  '**/helm/**',
  '**/.github/workflows/**',
  '**/.gitlab-ci*',
  '**/Jenkinsfile*',
  '**/*migration*/**',
  '**/migrations/**',
  '**/Procfile',
  '**/*.sql',
]

type Matcher = (rel: string) => boolean

// dot:true is load-bearing: '.env' and '.github/...' have leading dots
const cache = new Map<string, Matcher>()

function matcher(globs: string[]): Matcher {
  if (globs.length === 0) return () => false
  const key = globs.join('\n')
  let m = cache.get(key)
  if (!m) {
    m = picomatch(globs, { dot: true })
    cache.set(key, m)
  }
  return m
}

/** First match wins: secret > generated > vendor > infra > cfg.riskyGlobs. */
export function classifyRisk(
  rel: string,
  cfg: CtxConfig,
): { kind: FileKind | null; risk: RiskTag[] } {
  if (matcher(SECRET_GLOBS)(rel) || matcher(cfg.secretGlobs)(rel)) {
    return { kind: 'secret', risk: ['secret'] }
  }
  if (matcher(GENERATED_GLOBS)(rel)) return { kind: 'generated', risk: ['generated'] }
  if (matcher(VENDOR_GLOBS)(rel)) return { kind: 'vendor', risk: ['vendor'] }
  if (matcher(INFRA_GLOBS)(rel)) return { kind: 'infra', risk: ['infra'] }
  if (matcher(cfg.riskyGlobs)(rel)) return { kind: 'infra', risk: ['infra'] }
  return { kind: null, risk: [] }
}

/** Built-in secret globs + extras. Used by guard hooks on the hot path. */
export function isSecretPath(rel: string, extraGlobs: string[]): boolean {
  return matcher(SECRET_GLOBS)(rel) || matcher(extraGlobs)(rel)
}
