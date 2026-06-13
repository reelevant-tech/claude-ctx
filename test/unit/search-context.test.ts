import { describe, expect, it } from 'vitest'
import { cleanQuery, enumerationNudge, extractSearchQuery } from '../../src/hooks/search-context'

describe('cleanQuery', () => {
  it('strips regex/glob metacharacters down to search tokens', () => {
    expect(cleanQuery('create.*Invoice')).toBe('create Invoice')
    expect(cleanQuery('**/*invoice*')).toBe('invoice')
    expect(cleanQuery('"createInvoice"')).toBe('createInvoice')
    expect(cleanQuery('\\bfoo\\b')).toBe('foo')
    expect(cleanQuery('a_b-c')).toBe('a_b-c') // keep identifier chars
  })
})

describe('extractSearchQuery', () => {
  it('extracts the pattern from grep/rg/git grep', () => {
    expect(extractSearchQuery('grep -rn createInvoice src/')).toBe('createInvoice')
    expect(extractSearchQuery('grep -rn "create invoice" .')).toBe('create invoice')
    expect(extractSearchQuery('grep -e foo -e bar')).toBe('foo')
    expect(extractSearchQuery('rg buildPack')).toBe('buildPack')
    expect(extractSearchQuery('git grep traceSymbol')).toBe('traceSymbol')
    expect(extractSearchQuery('cat x | grep foo')).toBe('foo')
  })

  it('prefers the grep pattern over a find -name glob (find -exec grep)', () => {
    expect(
      extractSearchQuery('find /a/types/src -name "*.ts" -exec grep -l "RunContext" {} \\;'),
    ).toBe('RunContext')
    expect(extractSearchQuery('find . -name "*.ts" -exec grep -rn createInvoice {} +')).toBe('createInvoice')
  })

  it('extracts the name glob from find when there is no grep', () => {
    expect(extractSearchQuery('find . -name "*invoice*"')).toBe('invoice')
    expect(extractSearchQuery('find src -iname Customer.ts')).toBe('Customer ts') // '.' tokenized

  })

  it('returns null for non-search commands', () => {
    expect(extractSearchQuery('npm test')).toBeNull()
    expect(extractSearchQuery('cat .env')).toBeNull()
    expect(extractSearchQuery('ls -la')).toBeNull()
  })
})

describe('enumerationNudge', () => {
  it('fires for bare file enumerations (find/ls -R/tree)', () => {
    expect(enumerationNudge('find . -type f -name "*.ts"')).toContain('mcp__ctx__repo_tree')
    expect(enumerationNudge('ls -R src')).toContain('mcp__ctx__repo_tree')
    expect(enumerationNudge('tree -L 2')).toContain('mcp__ctx__repo_tree')
  })

  it('does not fire for content searches or ordinary commands', () => {
    expect(enumerationNudge('grep -rn foo .')).toBeNull()
    expect(enumerationNudge('npm test')).toBeNull()
    expect(enumerationNudge('ls -la')).toBeNull() // non-recursive
  })
})
