export type StoredInvoice = Record<string, unknown> & {
  exporter: { companyName?: string };
  consignee: { companyName?: string };
  shipment: { invoiceNumber: string };
  items: unknown[];
};

export function parseInvoice(value: unknown): StoredInvoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const invoice = value as Record<string, unknown>;
  const shipment = invoice.shipment;
  const exporter = invoice.exporter;
  const consignee = invoice.consignee;
  if (!shipment || typeof shipment !== 'object' || Array.isArray(shipment)) return null;
  if (!exporter || typeof exporter !== 'object' || Array.isArray(exporter)) return null;
  if (!consignee || typeof consignee !== 'object' || Array.isArray(consignee)) return null;
  if (!Array.isArray(invoice.items)) return null;

  const invoiceNumber = (shipment as { invoiceNumber?: unknown }).invoiceNumber;
  if (typeof invoiceNumber !== 'string' || invoiceNumber.trim().length === 0 || invoiceNumber.length > 200) {
    return null;
  }

  return invoice as StoredInvoice;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
