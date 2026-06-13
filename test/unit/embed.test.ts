import { describe, expect, it } from 'vitest'
import { createStubEmbedder } from '../../src/core/embed/stub'
import { fileEmbeddingText, flattenForChunks, symbolChunkText } from '../../src/core/embed/chunk'
import { dot, packVector, scoreEntries, unpackVector } from '../../src/core/embed/vectors'
import type { SymbolNode, VectorsShard } from '../../src/core/types'

describe('vectors pack/unpack', () => {
  it('round-trips a Float32 vector through base64', () => {
    const v = new Float32Array([0.1, -0.2, 0.3, 0.9])
    const packed = packVector(v)
    const back = unpackVector(packed, 4)
    for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(v[i]!, 5)
  })

  it('dot of equal normalized vectors is ~1', () => {
    const v = new Float32Array([0.6, 0.8])
    expect(dot(v, v)).toBeCloseTo(1, 5)
  })
})

describe('stub embedder', () => {
  it('gives higher cosine to texts sharing tokens', async () => {
    const e = createStubEmbedder(128)
    const [a, b, c] = await e.embed([
      'authentication session guard token',
      'session guard token verify',
      'unrelated pancake recipe banana',
    ])
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!))
  })

  it('produces L2-normalized vectors', async () => {
    const e = createStubEmbedder(64)
    const [v] = await e.embed(['hello world test'])
    expect(dot(v!, v!)).toBeCloseTo(1, 4)
  })
})

describe('fileEmbeddingText', () => {
  it('includes path words, exports, and code body (imports stripped)', () => {
    const text = fileEmbeddingText(
      'src/billing/invoice.ts',
      ['createInvoice', 'InvoiceStore'],
      [],
      "import { z } from 'zod'\nexport function createInvoice() { return rounding() }\n",
    )
    expect(text).toContain('src billing invoice')
    expect(text).toContain('createInvoice')
    expect(text).toContain('rounding')
    expect(text).not.toContain("import { z }")
  })
})

describe('symbol chunking', () => {
  const tree: SymbolNode[] = [
    { n: 'Card', k: 'struct', l: 1, endL: 1, x: true, sig: 'struct Card' },
    {
      n: 'Card',
      k: 'impl',
      l: 3,
      endL: 8,
      x: false,
      sig: 'impl Card',
      children: [{ n: 'shuffle', k: 'method', l: 4, endL: 6, x: true, sig: 'fn shuffle' }],
    },
  ]

  it('flattens nested nodes with their parent chain', () => {
    const flat = flattenForChunks(tree)
    expect(flat.map((f) => f.node.n)).toEqual(['Card', 'Card', 'shuffle'])
    const method = flat.find((f) => f.node.n === 'shuffle')!
    expect(method.parentChain).toEqual(['Card'])
  })

  it('symbolChunkText includes path words, parent chain, kind/name and body span', () => {
    const lines = 'struct Card\n\nimpl Card {\n  fn shuffle() { reseed() }\n}\n'.split('\n')
    const t = symbolChunkText('crates/core/cards.rs', ['Card'], tree[1]!.children![0]!, lines)
    expect(t).toContain('crates core cards rs')
    expect(t).toContain('Card method shuffle')
    expect(t).toContain('reseed()')
  })
})

describe('scoreEntries', () => {
  it('aggregates per-file max cosine and records the winning symbol', () => {
    const q = new Float32Array([1, 0])
    const shard: VectorsShard = {
      model: 'stub',
      dim: 2,
      createdAt: 0,
      hashes: {},
      entries: [
        { path: 'a.ts', startLine: 1, endLine: 9, vec: packVector(new Float32Array([0.3, 0.95])) },
        { path: 'a.ts', symbol: 'foo', kind: 'fn', startLine: 2, endLine: 4, vec: packVector(new Float32Array([1, 0])) },
        { path: 'b.ts', startLine: 1, endLine: 1, vec: packVector(new Float32Array([0, 1])) },
      ],
    }
    const hit = scoreEntries(q, shard)
    expect(hit.scores.get('a.ts')).toBeCloseTo(1, 5) // symbol chunk wins over file chunk
    expect(hit.symbols.get('a.ts')).toBe('foo')
    expect(hit.scores.get('b.ts')).toBeCloseTo(0, 5)
    expect(hit.symbols.has('b.ts')).toBe(false)
  })
})
