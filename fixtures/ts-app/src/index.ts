import { createInvoice } from '@app/billing/invoice'
import { formatMoney } from './util/format'

export function main(): void {
  const invoice = createInvoice({ id: 'c1', name: 'Ada' })
  console.log(invoice, formatMoney(42))
}
