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
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe secret/restricted keys (sk_live_…)
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google / GCP API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

const KV_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)(['"])([^'"]{8,})\3/gi

// Unquoted .env-style assignments: KEY=value at line start, no spaces around '='
// (the discriminator from `x = y` source code, which keeps secrets quoted or
// spaced). Redacts the value only. Anchored per-line so indented code is exempt.
const ENV_KV_PATTERN =
  /^([A-Za-z][A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)[A-Za-z0-9_]*)=(?!['"])(\S+)/gim

// Credentials embedded in a connection URL: scheme://user:pass@host. Keeps the
// scheme + host for context, strips the user:pass userinfo.
const URL_CRED_PATTERN =
  /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/)[^\s:@/]+:[^\s@/]+@/gi

const QUOTED_PATTERN = /(['"])([^'"\n]{20,})\1/g

export function redactSecrets(text: string): string {
  let out = text
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(URL_CRED_PATTERN, (_m: string, scheme: string) => `${scheme}${REDACTED}@`)
  out = out.replace(ENV_KV_PATTERN, (_m: string, key: string) => `${key}=${REDACTED}`)
  out = out.replace(
    KV_PATTERN,
    (_m: string, key: string, sep: string, q: string) => `${key}${sep}${q}${REDACTED}${q}`,
  )
  // High-entropy quoted blob → likely a secret, but only when it's contiguous:
  // real tokens/keys/hashes have no whitespace, whereas the common false positive
  // (a long English sentence in quotes) does. The whitespace test keeps prose,
  // messages, and descriptions intact while still catching random-looking blobs.
  out = out.replace(QUOTED_PATTERN, (m: string, q: string, body: string) =>
    !/\s/.test(body) && shannonEntropy(body) > 4 ? `${q}${REDACTED}${q}` : m,
  )
  return out
}
