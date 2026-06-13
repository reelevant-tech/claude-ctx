import { z } from 'zod'
import { Customer } from './customer'

export const TAX_RATE = 0.2

const amountSchema = z.number().positive()

export function createInvoice(c: Customer): string {
  const amount = amountSchema.parse(100) * (1 + TAX_RATE)
  return `invoice for ${c.name} (${c.id}): ${amount}`
}

export class InvoiceStore {
  private items: string[] = []

  add(invoice: string): void {
    this.items.push(invoice)
  }
}
