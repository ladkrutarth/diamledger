import { describe, expect, it } from 'vitest';
import { SURAT_TO_ANTWERP_PRESET } from '../data/sampleInvoices';
import { applyBuyer, buildNewInvoice, buyerFromConsignee, duplicateInvoice, todayIso } from './invoiceDefaults';

describe('invoice defaults', () => {
  it('starts a blank-numbered sample when no company profile exists', () => {
    const invoice = buildNewInvoice(null);
    expect(invoice.shipment.invoiceNumber).toBe('');
    expect(invoice.shipment.invoiceDate).toBe(todayIso());
    expect(invoice.items.length).toBe(SURAT_TO_ANTWERP_PRESET.items.length);
  });

  it('fills exporter, bank, and signatory from the company profile', () => {
    const invoice = buildNewInvoice({
      invoicePrefix: 'XYZ',
      authorizedSignatoryName: 'A. Shah',
      authorizedSignatoryDesignation: 'Director',
      exporter: { companyName: 'xyz LLC', iec: '' },
      bank: { bankName: 'HDFC Bank' },
    });
    expect(invoice.exporter.companyName).toBe('xyz LLC');
    expect(invoice.exporter.iec).toBe(SURAT_TO_ANTWERP_PRESET.exporter.iec);
    expect(invoice.bank.bankName).toBe('HDFC Bank');
    expect(invoice.authorizedSignatoryName).toBe('A. Shah');
    expect(invoice.consignee.companyName).toBe('');
    expect(invoice.items).toEqual([]);
  });

  it('duplicates an invoice without its number', () => {
    const copy = duplicateInvoice(SURAT_TO_ANTWERP_PRESET);
    expect(copy.shipment.invoiceNumber).toBe('');
    expect(copy.items).toHaveLength(SURAT_TO_ANTWERP_PRESET.items.length);
    expect(copy.items[0].id).not.toBe(SURAT_TO_ANTWERP_PRESET.items[0].id);
    expect(copy.consignee).toEqual(SURAT_TO_ANTWERP_PRESET.consignee);
  });

  it('round-trips a buyer into the consignee', () => {
    const buyer = { ...buyerFromConsignee(SURAT_TO_ANTWERP_PRESET.consignee), companyName: 'Dubai Gems', country: 'UAE' };
    const invoice = applyBuyer(buildNewInvoice({ invoicePrefix: '', authorizedSignatoryName: '', authorizedSignatoryDesignation: '', exporter: {}, bank: {} }), buyer);
    expect(invoice.consignee.companyName).toBe('Dubai Gems');
    expect(invoice.shipment.countryOfDestination).toBe('UAE');
  });
});
