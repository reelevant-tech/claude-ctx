/**
 * Secret redaction for any text claude-ctx emits (excerpts, packs, logs).
 * Idempotent: redacting already-redacted text is a no-op ('[REDACTED]' is too
 * short to re-trigger the quoted-entropy rule and matches no token shape).
 */

const REDACTED = '[REDACTED]'

export function shannonEntropy(s: string): number {
  const chars = Array.from(s)
  if (chars.length === 0) return 0
  const freq = new Map<string, number>()
  for (const c of chars) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const count of freq.values()) {
    const p = count / chars.length
    h -= p * Math.log2(p)
  }
  return h
}

// PEM blocks first (multiline, replace whole block), then specific token shapes.
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // unterminated paste: fail closed to end of text
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

const KV_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)(['"])([^'"]{8,})\3/gi

const QUOTED_PATTERN = /(['"])([^'"\n]{20,})\1/g

export function redactSecrets(text: string): string {
  let out = text
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(
    KV_PATTERN,
    (_m: string, key: string, sep: string, q: string) => `${key}${sep}${q}${REDACTED}${q}`,
  )
  out = out.replace(QUOTED_PATTERN, (m: string, q: string, body: string) =>
    shannonEntropy(body) > 4 ? `${q}${REDACTED}${q}` : m,
  )
  return out
}
