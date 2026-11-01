import { isRecord } from './http.js';

export { isUuid } from './http.js';

export type StoredInvoice = Record<string, unknown> & {
  exporter: Record<string, unknown>;
  consignee: Record<string, unknown> & { companyName?: string; country?: string };
  shipment: Record<string, unknown> & { invoiceNumber: string; invoiceDate?: string; countryOfDestination?: string };
  items: Array<Record<string, unknown>>;
};

export type InvoiceFacts = {
  invoiceNumber: string;
  buyerName: string;
  destinationCountry: string;
  invoiceDate: string | null;
  totalUsd: number;
  totalCarats: number;
};

export function parseInvoice(value: unknown): StoredInvoice | null {
  if (!isRecord(value)) return null;
  const { shipment, exporter, consignee, items } = value;
  if (!isRecord(shipment) || !isRecord(exporter) || !isRecord(consignee)) return null;
  if (!Array.isArray(items) || !items.every(isRecord)) return null;

  const invoiceNumber = shipment.invoiceNumber ?? '';
  if (typeof invoiceNumber !== 'string' || invoiceNumber.length > 200) return null;

  return value as StoredInvoice;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function invoiceFacts(invoice: StoredInvoice): InvoiceFacts {
  const itemsTotal = invoice.items.reduce((sum, item) => sum + toNumber(item.totalAmount), 0);
  const totalUsd =
    itemsTotal + toNumber(invoice.freightUsd) + toNumber(invoice.insuranceUsd) + toNumber(invoice.otherChargesUsd);
  const totalCarats = invoice.items.reduce((sum, item) => sum + toNumber(item.carats), 0);
  const rawDate = text(invoice.shipment.invoiceDate);

  return {
    invoiceNumber: text(invoice.shipment.invoiceNumber),
    buyerName: text(invoice.consignee.companyName),
    destinationCountry: text(invoice.shipment.countryOfDestination) || text(invoice.consignee.country),
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null,
    totalUsd: Math.round(totalUsd * 100) / 100,
    totalCarats: Math.round(totalCarats * 1000) / 1000,
  };
}

export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
