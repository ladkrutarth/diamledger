import type { InvoiceState } from '../../../src/types/invoice.js';

export { isUuid } from '../../core/http.js';
export { validateInvoice } from './invoiceSchema.js';

export type StoredInvoice = InvoiceState;

export type InvoiceFacts = {
  invoiceNumber: string;
  buyerName: string;
  destinationCountry: string;
  invoiceDate: string | null;
  creditDays: number;
  totalUsd: number;
  totalCarats: number;
};

export function invoiceFacts(invoice: StoredInvoice): InvoiceFacts {
  const itemsTotal = invoice.items.reduce((sum, item) => sum + item.totalAmount, 0);
  const totalUsd = itemsTotal + invoice.freightUsd + invoice.insuranceUsd + invoice.otherChargesUsd;
  const totalCarats = invoice.items.reduce((sum, item) => sum + item.carats, 0);
  const rawDate = invoice.shipment.invoiceDate.trim();

  return {
    invoiceNumber: invoice.shipment.invoiceNumber.trim(),
    buyerName: invoice.consignee.companyName.trim(),
    destinationCountry: invoice.shipment.countryOfDestination.trim() || invoice.consignee.country.trim(),
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null,
    creditDays: invoice.shipment.creditDays,
    totalUsd: Math.round(totalUsd * 100) / 100,
    totalCarats: Math.round(totalCarats * 1000) / 1000,
  };
}

export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
