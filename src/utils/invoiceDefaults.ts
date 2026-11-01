import type { BuyerContact, CompanyProfile } from '../api/client';
import { SURAT_TO_ANTWERP_PRESET } from '../data/sampleInvoices';
import type { ConsigneeDetails, InvoiceState } from '../types/invoice';

export const BUYER_KEYS = [
  'companyName', 'addressLine1', 'addressLine2', 'city', 'state', 'country', 'postalCode', 'taxIdVat',
  'contactPerson', 'email', 'phone',
] as const satisfies ReadonlyArray<keyof BuyerContact>;

export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const BLANK_CONSIGNEE: ConsigneeDetails = {
  companyName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  country: '',
  postalCode: '',
  taxIdVat: '',
  contactPerson: '',
  email: '',
  phone: '',
  buyerOtherThanConsignee: false,
};

function withoutEmpty<T extends object>(values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '' && value != null)) as Partial<T>;
}

export function buildNewInvoice(profile: CompanyProfile | null): InvoiceState {
  const preset = SURAT_TO_ANTWERP_PRESET;
  if (!profile) {
    return {
      ...preset,
      shipment: { ...preset.shipment, invoiceNumber: '', invoiceDate: todayIso() },
    };
  }

  return {
    ...preset,
    exporter: { ...preset.exporter, ...withoutEmpty(profile.exporter) },
    bank: { ...preset.bank, ...withoutEmpty(profile.bank) },
    consignee: { ...BLANK_CONSIGNEE },
    shipment: {
      ...preset.shipment,
      invoiceNumber: '',
      invoiceDate: todayIso(),
      exporterRef: '',
      buyerOrderRef: '',
      kpcsNumber: '',
      awbNumber: '',
      flightNumber: '',
      countryOfDestination: '',
      insurancePolicyNo: '',
    },
    items: [],
    freightUsd: 0,
    insuranceUsd: 0,
    otherChargesUsd: 0,
    authorizedSignatoryName: profile.authorizedSignatoryName || preset.authorizedSignatoryName,
    authorizedSignatoryDesignation: profile.authorizedSignatoryDesignation || preset.authorizedSignatoryDesignation,
  };
}

export function duplicateInvoice(invoice: InvoiceState): InvoiceState {
  return {
    ...invoice,
    shipment: { ...invoice.shipment, invoiceNumber: '', invoiceDate: todayIso(), awbNumber: '', kpcsNumber: '' },
    items: invoice.items.map((item) => ({ ...item, id: `${item.id}-copy-${Date.now()}` })),
  };
}

export function buyerFromConsignee(consignee: ConsigneeDetails): BuyerContact {
  const contact = {} as BuyerContact;
  for (const key of BUYER_KEYS) contact[key] = consignee[key] ?? '';
  return contact;
}

export function applyBuyer(invoice: InvoiceState, buyer: BuyerContact): InvoiceState {
  return {
    ...invoice,
    consignee: { ...invoice.consignee, ...buyer },
    shipment: {
      ...invoice.shipment,
      countryOfDestination: buyer.country || invoice.shipment.countryOfDestination,
    },
  };
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

export function formatCarats(value: number): string {
  return `${(value || 0).toFixed(3)} ct`;
}
