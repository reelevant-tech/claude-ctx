import { describe, expect, it } from 'vitest'
import { BEGIN, END, upsertManagedBlock } from '../../src/installer/claude-md'

const BLOCK = `${BEGIN}\n# managed content\n${END}`

describe('upsertManagedBlock', () => {
  it('creates a file when none exists', () => {
    expect(upsertManagedBlock(null, BLOCK)).toBe(BLOCK + '\n')
  })

  it('appends to a file without a managed block', () => {
    const out = upsertManagedBlock('# My project\n\nSome notes.\n', BLOCK)
    expect(out).toContain('# My project')
    expect(out).toContain(BEGIN)
    expect(out.indexOf('My project')).toBeLessThan(out.indexOf(BEGIN))
  })

  it('replaces an existing managed block in place', () => {
    const existing = `# Top\n\n${BEGIN}\nOLD\n${END}\n\n# Bottom\n`
    const out = upsertManagedBlock(existing, BLOCK)
    expect(out).toContain('# Top')
    expect(out).toContain('# Bottom')
    expect(out).toContain('# managed content')
    expect(out).not.toContain('OLD')
    expect(out.split(BEGIN).length).toBe(2) // exactly one block
  })

  it('is idempotent on re-upsert', () => {
    const once = upsertManagedBlock('# T\n', BLOCK)
    const twice = upsertManagedBlock(once, BLOCK)
    expect(twice.split(BEGIN).length).toBe(2)
  })
})
