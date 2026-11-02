import { z } from 'zod';
import type { InvoiceState } from '../../../src/types/invoice.js';

const text = (max = 500) => z.string().max(max);

const toNumber = (value: unknown) => {
  if (value === null || value === '') return 0;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
};

const amount = (max = 1e12) => z.preprocess(toNumber, z.number().finite().min(0).max(max));
const count = (max = 1e6) => z.preprocess(toNumber, z.number().int().min(0).max(max));

const exporter = z.object({
  companyName: text(200),
  addressLine1: text(),
  addressLine2: text(),
  city: text(100),
  state: text(100),
  stateCode: text(10),
  pincode: text(20),
  country: text(100),
  iec: text(20),
  gstin: text(20),
  pan: text(20),
  rcmcNo: text(100),
  email: text(320),
  phone: text(50),
});

const consignee = z.object({
  companyName: text(200),
  addressLine1: text(),
  addressLine2: text(),
  city: text(100),
  state: text(100),
  country: text(100),
  postalCode: text(20),
  taxIdVat: text(100),
  contactPerson: text(200),
  email: text(320),
  phone: text(50),
  buyerOtherThanConsignee: z.boolean(),
  buyerName: text(200).optional(),
  buyerAddress: text(1000).optional(),
  buyerCountry: text(100).optional(),
  buyerTaxId: text(100).optional(),
});

const shipment = z.object({
  invoiceNumber: text(200),
  invoiceDate: text(20),
  exporterRef: text(200),
  buyerOrderRef: text(200),
  kpcsNumber: text(200),
  lutNumber: text(200),
  incoterms: z.enum(['CIF', 'FOB', 'C&F', 'DAP', 'EXW']),
  incotermLocation: text(200),
  paymentTerms: text(),
  creditDays: count(365).default(30),
  portOfLoading: text(200),
  portOfDischarge: text(200),
  countryOfOrigin: text(100),
  countryOfDestination: text(100),
  carrierName: text(200),
  flightNumber: text(100),
  awbNumber: text(100),
  insurancePolicyNo: text(200).optional(),
});

const bank = z.object({
  bankName: text(200),
  branch: text(200),
  accountNumber: text(50),
  adCode: text(50),
  swiftCode: text(20),
  ifscCode: text(20),
  iban: text(50).optional(),
  correspondentBank: text(200).optional(),
  correspondentSwift: text(20).optional(),
});

const packing = z.object({
  vaultBoxNo: text(100),
  tamperSealNo: text(100),
  packageDimensions: text(100),
  numberOfPackages: count(10_000),
  tareWeightGrams: amount(1e7),
  grossWeightGrams: amount(1e7),
  securityBagNo: text(100),
});

const item = z
  .object({
    id: text(100),
    srNo: count(10_000),
    description: text(1000),
    shape: text(100).optional(),
    colorClarity: text(100).optional(),
    cutGrade: text(100).optional(),
    hsCode: z.string().trim().regex(/^[0-9.]{0,12}$/, 'HS code may only contain digits and dots'),
    certificateNo: text(200),
    parcelId: text(200),
    pieces: count(),
    carats: amount(1e6),
    ratePerCarat: amount(1e9),
    totalAmount: amount(),
  })
  .refine((line) => Math.abs(line.totalAmount - line.carats * line.ratePerCarat) <= 0.01, {
    message: 'Total amount must equal carats × rate per carat',
    path: ['totalAmount'],
  });

export const invoiceSchema = z.object({
  exporter,
  consignee,
  shipment,
  bank,
  packing,
  items: z.array(item).max(500, 'An invoice can have at most 500 lines'),
  currency: z.literal('USD'),
  exchangeRateInr: z.preprocess(toNumber, z.number().finite().positive().max(10_000)),
  freightUsd: amount(),
  insuranceUsd: amount(),
  otherChargesUsd: amount(),
  declarations: z.object({
    kimberleyClause: z.boolean(),
    naturalDiamondAffirmation: z.boolean(),
    gjepcOriginClause: z.boolean(),
    lutSupplyClause: z.boolean(),
  }),
  authorizedSignatoryName: text(200),
  authorizedSignatoryDesignation: text(200),
});

type SchemaInvoice = z.infer<typeof invoiceSchema>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesInvoiceType: Exact<SchemaInvoice, InvoiceState> = true;
void schemaMatchesInvoiceType;

function describeIssue(issue: z.core.$ZodIssue): string {
  const location = issue.path.map((part) => (typeof part === 'number' ? `line ${part + 1}` : String(part))).join(' › ');
  return location ? `${location}: ${issue.message}` : issue.message;
}

export type InvoiceParseResult = { ok: true; invoice: InvoiceState } | { ok: false; error: string };

export function validateInvoice(value: unknown): InvoiceParseResult {
  const result = invoiceSchema.safeParse(value);
  if (result.success) return { ok: true, invoice: result.data };
  const issues = result.error.issues.slice(0, 3).map(describeIssue);
  return { ok: false, error: `Invoice data is invalid. ${issues.join('; ')}.` };
}
