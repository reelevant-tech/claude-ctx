import { describe, expect, it } from 'vitest'
import { redactSecrets, shannonEntropy } from '../../src/core/guard/redact'

describe('shannonEntropy', () => {
  it('is 0 for uniform strings and empty input', () => {
    expect(shannonEntropy('')).toBe(0)
    expect(shannonEntropy('aaaa')).toBe(0)
  })

  it('is log2(n) for n distinct uniform symbols', () => {
    expect(shannonEntropy('abab')).toBe(1)
    expect(shannonEntropy('abcdefghijklmnop')).toBe(4)
  })

  it('stays below 4 for normal identifiers and paths', () => {
    expect(shannonEntropy('../core/store/shards')).toBeLessThan(4)
    expect(shannonEntropy('computeInvoiceTotal')).toBeLessThan(4)
  })
})

describe('redactSecrets', () => {
  it('redacts AWS access keys', () => {
    expect(redactSecrets('key AKIAIOSFODNN7EXAMPLE end')).toBe('key [REDACTED] end')
  })

  it('redacts github ghp_ tokens', () => {
    const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    expect(redactSecrets(`token ${t}`)).toBe('token [REDACTED]')
  })

  it('redacts github fine-grained PATs', () => {
    const t = 'github_pat_11AAAAAA0abcdefghijklmnopqrstuv'
    expect(redactSecrets(`x ${t} y`)).toBe('x [REDACTED] y')
  })

  it('redacts sk- style API keys', () => {
    expect(redactSecrets('sk-proj-abcdef1234567890abcdef')).toBe('[REDACTED]')
  })

  it('does not redact words merely containing sk-', () => {
    const s = 'task-abcdefghijklmnopqrstuv'
    expect(redactSecrets(s)).toBe(s)
  })

  it('redacts slack xox tokens', () => {
    expect(redactSecrets('xoxb-123456789012-abcdef')).toBe('[REDACTED]')
  })

  it('redacts Stripe sk_live_/sk_test_ keys (underscore form)', () => {
    expect(redactSecrets('key sk_live_abcdef1234567890ABCDEF end')).toBe('key [REDACTED] end')
    expect(redactSecrets('rk_test_0123456789abcdef')).toBe('[REDACTED]')
  })

  it('redacts Google/GCP AIza API keys', () => {
    const k = `AIza${'x'.repeat(35)}`
    expect(redactSecrets(`gcp ${k} ok`)).toBe('gcp [REDACTED] ok')
  })

  it('redacts credentials in a connection URL, keeping scheme + host', () => {
    expect(redactSecrets('postgres://user:pass@db.example.com:5432/app')).toBe(
      'postgres://[REDACTED]@db.example.com:5432/app',
    )
    expect(redactSecrets('mongodb+srv://u:p@cluster0.mongodb.net/db')).toBe(
      'mongodb+srv://[REDACTED]@cluster0.mongodb.net/db',
    )
  })

  it('redacts basic-auth credentials in an https URL', () => {
    expect(redactSecrets('curl https://admin:s3cr3tpass@api.example.com/v1')).toBe(
      'curl https://[REDACTED]@api.example.com/v1',
    )
  })

  it('redacts unquoted .env-style assignments (KEY=value at line start)', () => {
    expect(redactSecrets('CLIENT_SECRET=a1b2c3d4e5f6g7')).toBe('CLIENT_SECRET=[REDACTED]')
    expect(redactSecrets('client_secret=a1b2c3d4e5f6g7')).toBe('client_secret=[REDACTED]')
    const env = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcd'
    expect(redactSecrets(env)).toBe('GITHUB_TOKEN=[REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]')
  })

  it('does not redact spaced source assignments (x = y), only dotenv KEY=value', () => {
    const code = 'const sessionToken = getToken()'
    expect(redactSecrets(code)).toBe(code)
    const indented = '  const apiKey = config.apiKey'
    expect(redactSecrets(indented)).toBe(indented)
  })

  it('is idempotent on the new formats', () => {
    const text = [
      'sk_live_abcdef1234567890ABCDEF',
      'postgres://user:pass@db.example.com/app',
      'API_TOKEN=a1b2c3d4e5f6g7',
    ].join('\n')
    const once = redactSecrets(text)
    expect(redactSecrets(once)).toBe(once)
    expect(once).not.toContain('sk_live_abcdef')
    expect(once).not.toContain('user:pass')
  })

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts whole PEM private key blocks', () => {
    const pem =
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----\nafter'
    expect(redactSecrets(pem)).toBe('before\n[REDACTED]\nafter')
  })

  it('redacts key/value assignments but keeps the key name', () => {
    const out = redactSecrets('password: "hunter2hunter2"')
    expect(out).toBe('password: "[REDACTED]"')
    const out2 = redactSecrets("api_key = 'abcd1234efgh5678'")
    expect(out2).toBe("api_key = '[REDACTED]'")
    expect(out2).toContain('api_key')
  })

  it('leaves short key/value strings alone', () => {
    const s = 'password: "short12"'
    expect(redactSecrets(s)).toBe(s)
  })

  it('redacts high-entropy quoted strings', () => {
    const out = redactSecrets("const blob = 'kJ8#mP2$vX9@qL4&wZ7!nQ5'")
    expect(out).toBe("const blob = '[REDACTED]'")
  })

  it('keeps ordinary quoted strings', () => {
    const s = "msg = 'aaa bbb ccc ddd eee fff'"
    expect(redactSecrets(s)).toBe(s)
  })

  it('keeps long high-entropy English sentences (whitespace ⇒ prose, not a secret)', () => {
    // regression: this real error string measures >4 bits/char but is plainly not a secret
    const s = "process.stderr.write('Could not find built bundles (dist/hook.cjs). Run: npm run build')"
    expect(redactSecrets(s)).toBe(s)
    const desc = 'throw new Error("Failed to resolve the import specifier from the module graph cache")'
    expect(redactSecrets(desc)).toBe(desc)
  })

  it('still redacts a contiguous high-entropy blob (no whitespace, non-keyword)', () => {
    // 'blob' is not a KV keyword, so this exercises the entropy path, not KV_PATTERN
    expect(redactSecrets("const blob = 'kJ8#mP2$vX9@qL4&wZ7!nQ5'")).toBe("const blob = '[REDACTED]'")
  })

  it('keeps ordinary code intact', () => {
    const code =
      'export function computeInvoiceTotal(items: LineItem[]): number {\n' +
      '  return items.reduce((a, b) => a + b.amount, 0)\n' +
      '}\n' +
      '// see src/billing/invoice.ts'
    expect(redactSecrets(code)).toBe(code)
    const imp = "import { x } from '../core/store/shards'"
    expect(redactSecrets(imp)).toBe(imp)
  })

  it('is idempotent', () => {
    const text = [
      'AKIAIOSFODNN7EXAMPLE',
      'password: "hunter2hunter2"',
      "blob = 'kJ8#mP2$vX9@qL4&wZ7!nQ5'",
      '-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END PRIVATE KEY-----',
      'normal code stays here',
    ].join('\n')
    const once = redactSecrets(text)
    expect(redactSecrets(once)).toBe(once)
    expect(once).not.toContain('hunter2')
    expect(once).not.toContain('AKIA')
    expect(once).toContain('normal code stays here')
  })
})
