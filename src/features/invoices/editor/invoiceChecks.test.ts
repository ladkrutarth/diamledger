import { describe, expect, it } from 'vitest';
import { SURAT_TO_ANTWERP_PRESET } from '../../../data/sampleInvoices';
import type { InvoiceState } from '../../../types/invoice';
import { checkInvoice, invoiceTotals, issueCounts } from './invoiceChecks';

const today = new Date('2026-11-01T10:00:00');
const sample = (): InvoiceState => structuredClone(SURAT_TO_ANTWERP_PRESET);
const fields = (invoice: InvoiceState, severity: 'error' | 'warning' = 'error') =>
  checkInvoice(invoice, today).filter((issue) => issue.severity === severity).map((issue) => issue.field);

describe('invoice checks', () => {
  it('passes the sample invoice without errors', () => {
    const invoice = { ...sample(), shipment: { ...sample().shipment, invoiceDate: '2026-10-30' } };
    expect(fields(invoice)).toEqual([]);
  });

  it('flags wrong IEC, GSTIN, SWIFT, and AD code formats', () => {
    const invoice = sample();
    invoice.exporter.iec = '123';
    invoice.exporter.gstin = 'NOTAGSTIN';
    invoice.bank.swiftCode = 'HDFC';
    invoice.bank.adCode = '12AB';
    expect(fields(invoice)).toEqual(expect.arrayContaining(['exporter.iec', 'exporter.gstin', 'bank.swiftCode', 'bank.adCode']));
  });

  it('warns when the PAN or state code does not match the GSTIN', () => {
    const invoice = sample();
    invoice.exporter.gstin = '24ABCDE1234F1Z5';
    invoice.exporter.pan = 'ZZZZZ9999Z';
    invoice.exporter.stateCode = '27';
    expect(fields(invoice, 'warning')).toEqual(expect.arrayContaining(['exporter.pan', 'exporter.stateCode']));
  });

  it('needs a KP certificate and declaration for rough diamonds', () => {
    const invoice = sample();
    invoice.items[0] = { ...invoice.items[0], hsCode: '7102.31.00' };
    invoice.shipment.kpcsNumber = '';
    invoice.declarations.kimberleyClause = false;
    expect(fields(invoice)).toEqual(expect.arrayContaining(['shipment.kpcsNumber', 'declarations.kimberleyClause']));
  });

  it('needs the LUT ARN when the LUT clause is on', () => {
    const invoice = sample();
    invoice.declarations.lutSupplyClause = true;
    invoice.shipment.lutNumber = ' ';
    expect(fields(invoice)).toContain('shipment.lutNumber');
  });

  it('checks every line and finds a certificate used twice', () => {
    const invoice = sample();
    invoice.items = [
      { ...invoice.items[0], carats: 0, certificateNo: 'GIA 111' },
      { ...invoice.items[0], id: 'b', ratePerCarat: 0, certificateNo: 'GIA 111', hsCode: '7102' },
    ];
    expect(fields(invoice)).toEqual(expect.arrayContaining(['items.0.carats', 'items.1.ratePerCarat']));
    expect(fields(invoice, 'warning')).toEqual(expect.arrayContaining(['items.1.certificateNo', 'items.1.hsCode']));
  });

  it('adds up totals and counts issues by section', () => {
    const invoice = sample();
    invoice.items = [
      { ...invoice.items[0], pieces: 2, carats: 1.25, ratePerCarat: 480, totalAmount: 600 },
      { ...invoice.items[0], id: 'b', pieces: 1, carats: 1, ratePerCarat: 400, totalAmount: 400 },
    ];
    invoice.freightUsd = 30;
    invoice.insuranceUsd = 20;
    invoice.otherChargesUsd = 0;
    invoice.exchangeRateInr = 85;
    expect(invoiceTotals(invoice)).toEqual(expect.objectContaining({ pieces: 3, carats: 2.25, goodsUsd: 1000, chargesUsd: 50, totalUsd: 1050, totalInr: 89250 }));
    invoice.exporter.iec = '';
    expect(issueCounts(checkInvoice(invoice, today)).bySection.parties.errors).toBeGreaterThan(0);
  });
});
