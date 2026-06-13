import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchSymbols } from '../../src/cli/commands/symbols'
import { buildIndex } from '../../src/core/indexer/index'
import { loadIndex } from '../../src/core/store/shards'

let home: string
let repo: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ctx-proto-home-'))
  process.env.CLAUDE_CTX_HOME = home
  repo = mkdtempSync(join(tmpdir(), 'ctx-proto-'))
})
afterEach(() => {
  delete process.env.CLAUDE_CTX_HOME
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('symbol token index — prototype-pollution safety', () => {
  it('indexes and searches symbols named like Object.prototype members without throwing', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'proto', main: 'a.ts' }))
    // a top-level symbol whose camelCase split yields the token 'constructor'
    // (this is what crashed a real repo: tokenIndex['constructor'] was Object.prototype.constructor)
    writeFileSync(join(repo, 'a.ts'), 'export class MyConstructor {}\nexport function alpha() {}\n')

    // build must not throw (token 'constructor' collides with Object.prototype)
    await expect(buildIndex(repo, { mode: 'full' })).resolves.toBeTruthy()
    const idx = loadIndex(repo)!

    // the symbol is findable via its 'constructor' sub-token
    expect(searchSymbols(idx, 'constructor', {}).some((s) => s.n === 'MyConstructor')).toBe(true)

    // querying a prototype key that is NOT an indexed token must not throw and return []
    expect(() => searchSymbols(idx, '__proto__', {})).not.toThrow()
    expect(searchSymbols(idx, '__proto__', {})).toEqual([])
    expect(searchSymbols(idx, 'toLocaleString', {})).toEqual([])
  })
})
