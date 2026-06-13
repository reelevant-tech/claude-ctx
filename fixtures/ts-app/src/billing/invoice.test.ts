import { describe, it, expect } from 'vitest'
import { createInvoice, TAX_RATE } from './invoice'

describe('invoice', () => {
  it('creates an invoice string', () => {
    expect(createInvoice({ id: 'c1', name: 'Ada' })).toContain('Ada')
    expect(TAX_RATE).toBe(0.2)
  })
})
