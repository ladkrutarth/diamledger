import type { InvoiceState } from '../../../types/invoice';

/**
 * Checks an export invoice before it is issued. Errors block issuing; warnings are shown but do not.
 * The server validates the data shape again on save (server/modules/invoices/invoiceSchema.ts); these
 * checks add the export-document rules a customs broker or bank would otherwise send back.
 */

export type SectionKey = 'parties' | 'shipment' | 'goods' | 'packing' | 'bank' | 'compliance';

export type InvoiceIssue = {
  section: SectionKey;
  /** Dotted path of the field, such as "exporter.iec" or "items.2.carats". */
  field: string;
  severity: 'error' | 'warning';
  /** "required" issues are only shown inline after the user tries to issue; "invalid" ones at once. */
  kind: 'required' | 'invalid';
  message: string;
};

export const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'parties', label: 'Parties' },
  { key: 'shipment', label: 'Shipment' },
  { key: 'goods', label: 'Goods' },
  { key: 'packing', label: 'Packing' },
  { key: 'bank', label: 'Bank' },
  { key: 'compliance', label: 'Compliance' },
];

const PATTERNS = {
  iec: /^[A-Z0-9]{10}$/,
  gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  adCode: /^[0-9]{7}([0-9]{7})?$/,
  swift: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  hsCode: /^[0-9]{8}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

export function isRoughHsCode(hsCode: string): boolean {
  const digits = hsCode.replace(/\D/g, '');
  return digits.startsWith('710210') || digits.startsWith('710221') || digits.startsWith('710231');
}

export type InvoiceTotals = {
  lines: number;
  pieces: number;
  carats: number;
  goodsUsd: number;
  chargesUsd: number;
  totalUsd: number;
  totalInr: number;
  averageRateUsd: number;
};

export function invoiceTotals(invoice: InvoiceState): InvoiceTotals {
  const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
  const pieces = invoice.items.reduce((sum, item) => sum + (Number(item.pieces) || 0), 0);
  const carats = round(invoice.items.reduce((sum, item) => sum + (Number(item.carats) || 0), 0), 3);
  const goodsUsd = round(invoice.items.reduce((sum, item) => sum + (Number(item.totalAmount) || 0), 0));
  const chargesUsd = round((Number(invoice.freightUsd) || 0) + (Number(invoice.insuranceUsd) || 0) + (Number(invoice.otherChargesUsd) || 0));
  const totalUsd = round(goodsUsd + chargesUsd);
  return {
    lines: invoice.items.length,
    pieces,
    carats,
    goodsUsd,
    chargesUsd,
    totalUsd,
    totalInr: round(totalUsd * (Number(invoice.exchangeRateInr) || 0)),
    averageRateUsd: carats > 0 ? round(goodsUsd / carats) : 0,
  };
}

export function checkInvoice(invoice: InvoiceState, today = new Date()): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const add = (section: SectionKey, field: string, severity: InvoiceIssue['severity'], kind: InvoiceIssue['kind'], message: string) =>
    issues.push({ section, field, severity, kind, message });
  const blank = (value: string | undefined | null) => !String(value ?? '').trim();
  const clean = (value: string | undefined | null) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const required = (section: SectionKey, field: string, value: string | undefined, label: string, severity: InvoiceIssue['severity'] = 'error') => {
    if (blank(value)) add(section, field, severity, 'required', `${label} is missing.`);
  };
  const format = (section: SectionKey, field: string, value: string | undefined, pattern: RegExp, message: string, severity: InvoiceIssue['severity'] = 'error') => {
    if (!blank(value) && !pattern.test(clean(value))) add(section, field, severity, 'invalid', message);
  };

  // Parties
  const { exporter, consignee } = invoice;
  required('parties', 'exporter.companyName', exporter.companyName, 'Exporter name');
  required('parties', 'exporter.addressLine1', exporter.addressLine1, 'Exporter address');
  required('parties', 'exporter.iec', exporter.iec, 'IEC');
  format('parties', 'exporter.iec', exporter.iec, PATTERNS.iec, 'IEC should be 10 letters or digits.');
  required('parties', 'exporter.gstin', exporter.gstin, 'GSTIN');
  format('parties', 'exporter.gstin', exporter.gstin, PATTERNS.gstin, 'GSTIN should be 15 characters, like 24ABCDE1234F1Z5.');
  required('parties', 'exporter.pan', exporter.pan, 'PAN', 'warning');
  format('parties', 'exporter.pan', exporter.pan, PATTERNS.pan, 'PAN should look like ABCDE1234F.');
  if (PATTERNS.gstin.test(clean(exporter.gstin)) && PATTERNS.pan.test(clean(exporter.pan)) && clean(exporter.gstin).slice(2, 12) !== clean(exporter.pan)) {
    add('parties', 'exporter.pan', 'warning', 'invalid', 'The PAN does not match characters 3–12 of the GSTIN.');
  }
  if (PATTERNS.gstin.test(clean(exporter.gstin)) && !blank(exporter.stateCode) && clean(exporter.gstin).slice(0, 2) !== clean(exporter.stateCode).padStart(2, '0')) {
    add('parties', 'exporter.stateCode', 'warning', 'invalid', `State code should be ${clean(exporter.gstin).slice(0, 2)}, the first two digits of the GSTIN.`);
  }
  required('parties', 'exporter.rcmcNo', exporter.rcmcNo, 'GJEPC RCMC number', 'warning');
  required('parties', 'consignee.companyName', consignee.companyName, 'Consignee name');
  required('parties', 'consignee.addressLine1', consignee.addressLine1, 'Consignee address');
  required('parties', 'consignee.country', consignee.country, 'Consignee country');
  if (consignee.buyerOtherThanConsignee) required('parties', 'consignee.buyerName', consignee.buyerName, 'Buyer name');

  // Shipment
  const { shipment } = invoice;
  required('shipment', 'shipment.invoiceDate', shipment.invoiceDate, 'Invoice date');
  if (!blank(shipment.invoiceDate)) {
    const parsed = PATTERNS.date.test(shipment.invoiceDate) ? new Date(`${shipment.invoiceDate}T00:00:00`) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) add('shipment', 'shipment.invoiceDate', 'error', 'invalid', 'Invoice date is not a valid date.');
    else if (parsed.getTime() - today.getTime() > 86_400_000) add('shipment', 'shipment.invoiceDate', 'warning', 'invalid', 'Invoice date is in the future.');
  }
  required('shipment', 'shipment.portOfLoading', shipment.portOfLoading, 'Port of loading');
  required('shipment', 'shipment.portOfDischarge', shipment.portOfDischarge, 'Port of discharge');
  required('shipment', 'shipment.countryOfDestination', shipment.countryOfDestination, 'Country of final destination');
  required('shipment', 'shipment.incotermLocation', shipment.incotermLocation, 'Incoterm place', 'warning');
  required('shipment', 'shipment.paymentTerms', shipment.paymentTerms, 'Payment terms', 'warning');
  if (!Number.isInteger(Number(shipment.creditDays)) || shipment.creditDays < 0 || shipment.creditDays > 365) {
    add('shipment', 'shipment.creditDays', 'error', 'invalid', 'Credit days must be a whole number from 0 to 365.');
  }
  required('shipment', 'shipment.carrierName', shipment.carrierName, 'Carrier', 'warning');
  required('shipment', 'shipment.awbNumber', shipment.awbNumber, 'Air waybill number', 'warning');

  // Goods
  if (invoice.items.length === 0) add('goods', 'items', 'error', 'required', 'Add at least one line.');
  const certificates = new Map<string, number[]>();
  invoice.items.forEach((item, index) => {
    const line = `Line ${index + 1}`;
    const at = (field: string) => `items.${index}.${field}`;
    if (blank(item.description)) add('goods', at('description'), 'error', 'required', `${line}: description is missing.`);
    if (!(Number(item.carats) > 0)) add('goods', at('carats'), 'error', 'invalid', `${line}: carats must be more than 0.`);
    if (!(Number(item.ratePerCarat) > 0)) add('goods', at('ratePerCarat'), 'error', 'invalid', `${line}: rate per carat must be more than 0.`);
    if (!(Number(item.pieces) >= 1) || !Number.isInteger(Number(item.pieces))) add('goods', at('pieces'), 'error', 'invalid', `${line}: pieces must be a whole number of 1 or more.`);
    if (blank(item.hsCode)) add('goods', at('hsCode'), 'error', 'required', `${line}: HS code is missing.`);
    else if (!/^[0-9.]+$/.test(item.hsCode.trim())) add('goods', at('hsCode'), 'error', 'invalid', `${line}: HS code may only contain digits and dots.`);
    else if (!PATTERNS.hsCode.test(item.hsCode.replace(/\D/g, ''))) add('goods', at('hsCode'), 'warning', 'invalid', `${line}: shipping bills need an 8-digit HS code, such as 7102.39.10.`);
    else if (!item.hsCode.replace(/\D/g, '').startsWith('7102')) add('goods', at('hsCode'), 'warning', 'invalid', `${line}: diamonds are under HS 7102.`);
    const certificate = clean(item.certificateNo);
    const pending = !certificate || /PENDING|^N\/?A$|^NONE$/.test(certificate);
    if (pending && Number(item.pieces) === 1 && Number(item.carats) >= 0.3 && !isRoughHsCode(item.hsCode)) {
      add('goods', at('certificateNo'), 'warning', 'required', `${line}: single stone of 0.30 ct or more without a grading certificate.`);
    }
    if (!pending) certificates.set(certificate, [...(certificates.get(certificate) ?? []), index + 1]);
  });
  for (const [certificate, lines] of certificates) {
    if (lines.length > 1) add('goods', `items.${lines[1] - 1}.certificateNo`, 'warning', 'invalid', `Certificate ${certificate} is on lines ${lines.join(' and ')}.`);
  }
  if (!(Number(invoice.exchangeRateInr) > 0)) add('goods', 'exchangeRateInr', 'error', 'invalid', 'Exchange rate must be more than 0.');
  for (const [field, label] of [['freightUsd', 'Freight'], ['insuranceUsd', 'Insurance'], ['otherChargesUsd', 'Other charges']] as const) {
    if (Number(invoice[field]) < 0) add('goods', field, 'error', 'invalid', `${label} cannot be negative.`);
  }

  // Packing
  const { packing } = invoice;
  if (Number(packing.grossWeightGrams) > 0 && Number(packing.tareWeightGrams) > Number(packing.grossWeightGrams)) {
    add('packing', 'packing.tareWeightGrams', 'warning', 'invalid', 'Tare weight is more than the gross weight.');
  }
  if (!(Number(packing.numberOfPackages) >= 1)) add('packing', 'packing.numberOfPackages', 'warning', 'invalid', 'Number of packages should be at least 1.');
  required('packing', 'packing.tamperSealNo', packing.tamperSealNo, 'Tamper seal number', 'warning');

  // Bank
  const { bank } = invoice;
  required('bank', 'bank.bankName', bank.bankName, 'Bank name');
  required('bank', 'bank.accountNumber', bank.accountNumber, 'Account number');
  required('bank', 'bank.swiftCode', bank.swiftCode, 'SWIFT code');
  format('bank', 'bank.swiftCode', bank.swiftCode, PATTERNS.swift, 'SWIFT code should be 8 or 11 characters, like HDFCINBBXXX.');
  required('bank', 'bank.adCode', bank.adCode, 'AD code');
  // Often written with a hyphen between the bank and branch parts, such as 0210045-8941203.
  if (!blank(bank.adCode) && (!/^[0-9\s-]+$/.test(bank.adCode) || !PATTERNS.adCode.test(bank.adCode.replace(/\D/g, '')))) {
    add('bank', 'bank.adCode', 'error', 'invalid', 'AD code should be 14 digits (7 digits for some banks), like 0210045-8941203.');
  }
  format('bank', 'bank.ifscCode', bank.ifscCode, PATTERNS.ifsc, 'IFSC should be 11 characters, like HDFC0000123.', 'warning');

  // Compliance
  const rough = invoice.items.some((item) => isRoughHsCode(item.hsCode));
  if (rough) {
    required('compliance', 'shipment.kpcsNumber', shipment.kpcsNumber, 'Kimberley Process certificate number (rough diamonds)');
    if (!invoice.declarations.kimberleyClause) add('compliance', 'declarations.kimberleyClause', 'error', 'required', 'Rough diamonds need the Kimberley Process declaration.');
  } else if (!invoice.declarations.kimberleyClause) {
    add('compliance', 'declarations.kimberleyClause', 'warning', 'required', 'The Kimberley Process System of Warranties statement is expected on diamond invoices.');
  }
  if (invoice.declarations.lutSupplyClause) required('compliance', 'shipment.lutNumber', shipment.lutNumber, 'LUT ARN (needed for the LUT clause)');
  if (!invoice.declarations.naturalDiamondAffirmation) add('compliance', 'declarations.naturalDiamondAffirmation', 'warning', 'required', 'The natural diamond statement is not ticked.');
  required('compliance', 'authorizedSignatoryName', invoice.authorizedSignatoryName, 'Authorised signatory');

  return issues;
}

export function issueCounts(issues: InvoiceIssue[]) {
  const bySection = Object.fromEntries(SECTIONS.map(({ key }) => [key, { errors: 0, warnings: 0 }])) as Record<SectionKey, { errors: number; warnings: number }>;
  for (const issue of issues) bySection[issue.section][issue.severity === 'error' ? 'errors' : 'warnings'] += 1;
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    bySection,
  };
}
