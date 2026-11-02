import { InvoiceState } from '../types/invoice';
// The presets are data shared with the Python API (backend/), which seeds demo invoices from them.
// bank.adCode is the 14-digit Customs Authorized Dealer code.
import presets from './sampleInvoices.json';

export const SURAT_TO_ANTWERP_PRESET: InvoiceState = presets.suratToAntwerp as InvoiceState;

export const MUMBAI_TO_NY_PRESET: InvoiceState = presets.mumbaiToNewYork as InvoiceState;

export const SURAT_TO_DUBAI_PRESET: InvoiceState = presets.suratToDubai as InvoiceState;
