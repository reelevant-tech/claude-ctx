import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearTsRefsCache, findTsReferences } from '../../src/core/ast/ts-refs'
import { buildIndex } from '../../src/core/indexer/index'
import { loadIndex } from '../../src/core/store/shards'

const FIX = join(__dirname, '..', '..', 'fixtures', 'ts-app')

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-tsrefs-'))
  process.env.CLAUDE_CTX_HOME = home
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  clearTsRefsCache()
})

describe('findTsReferences', () => {
  it('finds cross-file references including path aliases', async () => {
    await buildIndex(FIX, { mode: 'full' })
    const idx = loadIndex(FIX)!
    const cacheKey = idx.meta.indexedAt
    const refs = findTsReferences(FIX, idx, 'createInvoice', cacheKey)!
    expect(refs).not.toBeNull()
    const files = refs!.map((r) => r.file)
    expect(files).toContain('src/index.ts')
    expect(files).not.toContain('node_modules')
  })

  it('does not conflate shadowed local names with exported symbols', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ctx-shadow-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true },
        include: ['src'],
      }),
    )
    writeFileSync(
      join(root, 'src', 'lib.ts'),
      `export function compute(): number { return 1 }\n`,
    )
    writeFileSync(
      join(root, 'src', 'main.ts'),
      `import { compute as imported } from './lib'
function compute(): number { return 2 }
export function run(): number { return imported() + compute() }
`,
    )
    await buildIndex(root, { mode: 'full' })
    const idx = loadIndex(root)!
    clearTsRefsCache()
    const refs = findTsReferences(root, idx, 'compute', cacheKeyFrom(idx), 'src/lib.ts')!
    expect(refs).not.toBeNull()
    const lines = refs!.map((r) => `${r.file}:${r.line}`)
    expect(lines.some((l) => l.startsWith('src/main.ts'))).toBe(true)
    // shadowed local `compute` on L2 must not reference the export from lib.ts
    expect(lines).not.toContain('src/main.ts:2')
  })
})

function cacheKeyFrom(idx: NonNullable<ReturnType<typeof loadIndex>>): number {
  return idx.meta.indexedAt
}
