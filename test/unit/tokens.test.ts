import { describe, expect, it } from 'vitest'
import {
  ALIAS_WEIGHT,
  expandTaskTokens,
  foldAccents,
  splitIdentifier,
  tokenizeTask,
} from '../../src/core/tokens'

describe('splitIdentifier', () => {
  it('splits camelCase into whole words (not characters)', () => {
    expect(splitIdentifier('contextPack')).toEqual(['context', 'pack'])
  })
  it('splits PascalCase compounds', () => {
    expect(splitIdentifier('UserPromptSubmit')).toEqual(['user', 'prompt', 'submit'])
  })
  it('splits snake_case / kebab and letter↔digit boundaries', () => {
    expect(splitIdentifier('foo_bar-baz42')).toEqual(['foo', 'bar', 'baz', '42'])
  })
  it('splits acronym runs and digit boundaries (HTTPServer2Config)', () => {
    expect(splitIdentifier('HTTPServer2Config')).toEqual(['http', 'server', '2', 'config'])
  })
  it('folds accents before splitting', () => {
    expect(splitIdentifier('données_brutes')).toEqual(['donnees', 'brutes'])
  })
  it('returns an empty array for non-alphanumeric input', () => {
    expect(splitIdentifier('___')).toEqual([])
    expect(splitIdentifier('')).toEqual([])
  })
})

describe('foldAccents', () => {
  it('strips French diacritics', () => {
    expect(foldAccents('données')).toBe('donnees')
    expect(foldAccents('exécution')).toBe('execution')
    expect(foldAccents('réseau')).toBe('reseau')
  })
})

describe('tokenizeTask with accent folding', () => {
  it('keeps accented words as whole clean tokens (not split on the accent)', () => {
    const toks = tokenizeTask('exécution du workflow').map((t) => t.t)
    expect(toks).toContain('execution') // not "cution"
    expect(toks).toContain('workflow')
    expect(toks).not.toContain('cution')
  })
  it('"base de données" yields a clean donnees token', () => {
    const toks = tokenizeTask('base de données').map((t) => t.t)
    expect(toks.some((t) => t.startsWith('donnee'))).toBe(true)
    expect(toks).not.toContain('donn')
  })
})

describe('tokenizeTask with alphanumeric identifiers', () => {
  it('keeps the distinctive short parts of a mixed letter/digit identifier', () => {
    // BM25F must reach BM25_K1 / BM25_B in the index, which keeps "bm"/"25".
    const toks = tokenizeTask('how does BM25F scoring work').map((t) => t.t)
    expect(toks).toContain('bm')
    expect(toks).toContain('25')
  })
  it('keeps the digit part of P95-style identifiers', () => {
    const toks = tokenizeTask('the P95 latency metric').map((t) => t.t)
    expect(toks).toContain('95')
  })
  it('still drops short noise tokens from plain (non-mixed) words', () => {
    // "id"/"to" are short and from non-mixed words → stay filtered out.
    const toks = tokenizeTask('map id to user').map((t) => t.t)
    expect(toks).not.toContain('id')
    expect(toks).not.toContain('to')
  })
  it('does not keep single-character parts even from a mixed word', () => {
    const toks = tokenizeTask('the P95 value').map((t) => t.t)
    expect(toks).not.toContain('p')
  })
})

describe('expandTaskTokens', () => {
  it('adds FR→EN aliases at reduced weight, keeps originals at full weight', () => {
    const base = tokenizeTask('connexion à la base de données')
    const exp = expandTaskTokens(base)
    const m = new Map(exp.map((t) => [t.t, t.q]))
    expect(m.has('database')).toBe(true)
    expect(m.has('connection')).toBe(true)
    // alias weight is below the original token weight
    expect(m.get('database')!).toBeCloseTo(1 * ALIAS_WEIGHT, 5)
    const donnees = exp.find((t) => t.t.startsWith('donnee'))!
    expect(donnees.q).toBe(1) // original keeps full weight
  })

  it('supports per-repo extra aliases for domain jargon', () => {
    const base = tokenizeTask('binding dynamique')
    const exp = expandTaskTokens(base, { binding: ['dependency', 'dependencies'] })
    const toks = exp.map((t) => t.t)
    expect(toks).toContain('dependency')
    expect(toks).toContain('dependencies')
  })

  it('is a no-op for tokens with no alias', () => {
    const base = tokenizeTask('fix invoice rounding')
    expect(expandTaskTokens(base)).toEqual(base)
  })
})
