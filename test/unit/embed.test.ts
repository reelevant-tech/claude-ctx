import { describe, expect, it } from 'vitest'
import { createStubEmbedder } from '../../src/core/embed/stub'
import { fileEmbeddingText } from '../../src/core/embed/chunk'
import { cosineMap, dot, packVector, unpackVector } from '../../src/core/embed/vectors'
import type { VectorsShard } from '../../src/core/types'

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

describe('cosineMap', () => {
  it('scores every stored file against the query', () => {
    const q = new Float32Array([1, 0])
    const shard: VectorsShard = {
      model: 'stub',
      dim: 2,
      vectors: { 'a.ts': packVector(new Float32Array([1, 0])), 'b.ts': packVector(new Float32Array([0, 1])) },
    }
    const m = cosineMap(q, shard)
    expect(m.get('a.ts')).toBeCloseTo(1, 5)
    expect(m.get('b.ts')).toBeCloseTo(0, 5)
  })
})
