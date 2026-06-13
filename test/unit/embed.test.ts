import { describe, expect, it } from 'vitest'
import { createStubEmbedder } from '../../src/core/embed/stub'
import { fileEmbeddingText, flattenForChunks, symbolChunkText } from '../../src/core/embed/chunk'
import { embeddableFiles } from '../../src/core/embed/build'
import { dot, packVector, scoreEntries, unpackVector } from '../../src/core/embed/vectors'
import type { FileRecord, FilesShard, SymbolNode, VectorsShard } from '../../src/core/types'

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

describe('symbolChunkText leading doc-comment', () => {
  it('prepends a JSDoc block sitting above the symbol', () => {
    const src = [
      "import { z } from 'zod'",
      '/**',
      ' * Creates an invoice for a customer with tax applied.',
      ' */',
      'export function createInvoice(c) { return rounding(c) }',
    ]
    const node: SymbolNode = { n: 'createInvoice', k: 'fn', l: 5, endL: 5, x: true, sig: 'export function createInvoice' }
    const t = symbolChunkText('src/billing/invoice.ts', [], node, src)
    expect(t).toContain('Creates an invoice for a customer with tax applied')
    expect(t).toContain('createInvoice')
    expect(t).toContain('rounding(c)')
  })
})

describe('embeddableFiles exclusions', () => {
  function rec(over: Partial<FileRecord>): FileRecord {
    return { h: 'h', mtime: 0, size: 0, lines: 1, lang: 'ts', pkg: -1, parser: 'ts-api', kind: 'source', risk: [], entry: false, exports: [], externalDeps: [], docHeadings: [], tests: [], ...over }
  }
  it('excludes tests, fixtures, snapshots, generated, secret; keeps real source/doc/config', () => {
    const files: FilesShard = {
      files: {
        'src/app.ts': rec({}),
        'README.md': rec({ kind: 'doc', parser: 'lexical' }),
        'package.json': rec({ kind: 'config', parser: 'none' }),
        'src/app.test.ts': rec({ kind: 'test' }),
        'e2e/fixtures/product.json': rec({ kind: 'config', parser: 'none' }),
        'src/__snapshots__/x.snap': rec({ kind: 'config', parser: 'none' }),
        'dist/bundle.js': rec({ kind: 'generated', risk: ['generated'] }),
        '.env': rec({ kind: 'secret', parser: 'none' }),
      },
    }
    expect(embeddableFiles(files)).toEqual(['README.md', 'package.json', 'src/app.ts'])
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
