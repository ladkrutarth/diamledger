// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MUMBAI_TO_NY_PRESET, SURAT_TO_ANTWERP_PRESET, SURAT_TO_DUBAI_PRESET } from '../data/sampleInvoices';
import type { InvoiceState } from '../types/invoice';
import { generateTallyPrimeXML } from './tallyGenerator';

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

function text(parent: Element | Document, tag: string): string {
  return parent.getElementsByTagName(tag)[0]?.textContent ?? '';
}

function amountOf(entry: Element, tag: 'AMOUNT' | 'BASEAMOUNT'): number {
  return Number(text(entry, tag).replace(/[$\s]/g, ''));
}

function cents(value: number): number {
  return Math.round(value * 100);
}

/** Debit (party) minus every credit line, in cents. Tally requires zero. */
function imbalance(doc: Document, tag: 'AMOUNT' | 'BASEAMOUNT'): number {
  const voucher = doc.getElementsByTagName('VOUCHER')[0];
  const lines = [
    ...Array.from(voucher.getElementsByTagName('ALLLEDGERENTRIES.LIST')),
    ...Array.from(voucher.getElementsByTagName('ALLINVENTORYENTRIES.LIST')),
  ];
  return lines.reduce((sum, line) => sum + cents(amountOf(line, tag)), 0);
}

function ledgerNames(doc: Document): string[] {
  return Array.from(doc.getElementsByTagName('ALLLEDGERENTRIES.LIST')).map((entry) => text(entry, 'LEDGERNAME'));
}

describe('generateTallyPrimeXML', () => {
  it.each([
    ['Surat to Antwerp', SURAT_TO_ANTWERP_PRESET],
    ['Mumbai to New York', MUMBAI_TO_NY_PRESET],
    ['Surat to Dubai', SURAT_TO_DUBAI_PRESET],
  ])('produces a balanced export voucher for %s', (_name, invoice) => {
    const doc = parse(generateTallyPrimeXML(invoice));

    expect(text(doc, 'DATE')).toBe(invoice.shipment.invoiceDate.replace(/-/g, ''));
    expect(text(doc, 'VOUCHERNUMBER')).toBe(invoice.shipment.invoiceNumber);
    expect(text(doc, 'PARTYLEDGERNAME')).toBe(invoice.consignee.companyName);
    expect(text(doc, 'SVCURRENTCOMPANY')).toBe(invoice.exporter.companyName);
    expect(text(doc, 'BASICCURRENCYRATE')).toBe(invoice.exchangeRateInr.toFixed(2));
    expect(doc.getElementsByTagName('ALLINVENTORYENTRIES.LIST')).toHaveLength(invoice.items.length);
    expect(text(doc, 'NARRATION')).toContain(`LUT ARN: ${invoice.shipment.lutNumber}`);

    const expectedUsd =
      invoice.items.reduce((sum, item) => sum + item.totalAmount, 0) + invoice.freightUsd + invoice.insuranceUsd;
    const party = doc.getElementsByTagName('ALLLEDGERENTRIES.LIST')[0];
    expect(amountOf(party, 'AMOUNT')).toBeCloseTo(expectedUsd, 2);
    expect(amountOf(party, 'BASEAMOUNT')).toBeCloseTo(expectedUsd * invoice.exchangeRateInr, 0);

    expect(imbalance(doc, 'AMOUNT')).toBe(0);
    expect(imbalance(doc, 'BASEAMOUNT')).toBe(0);
  });

  it('writes each diamond lot in carats with USD and INR values', () => {
    const doc = parse(generateTallyPrimeXML(SURAT_TO_ANTWERP_PRESET));
    const first = doc.getElementsByTagName('ALLINVENTORYENTRIES.LIST')[0];
    const item = SURAT_TO_ANTWERP_PRESET.items[0];

    expect(text(first, 'BILLEDQTY')).toBe(`${item.carats.toFixed(3)} CTS`);
    expect(text(first, 'RATE')).toBe(`$ ${item.ratePerCarat.toFixed(2)}/CTS`);
    expect(text(first, 'BATCHNAME')).toBe(`LOT-${item.parcelId}`);
    expect(text(first, 'HSNCODE')).toBe(item.hsCode);
    expect(amountOf(first, 'AMOUNT')).toBeCloseTo(-item.totalAmount, 2);
  });

  it('credits other charges so the voucher still balances', () => {
    const invoice: InvoiceState = { ...SURAT_TO_ANTWERP_PRESET, otherChargesUsd: 125.5 };
    const doc = parse(generateTallyPrimeXML(invoice));

    expect(ledgerNames(doc)).toContain('Other Export Charges');
    expect(imbalance(doc, 'AMOUNT')).toBe(0);
    expect(imbalance(doc, 'BASEAMOUNT')).toBe(0);
  });

  it('keeps rupee totals balanced when each line rounds differently', () => {
    const invoice: InvoiceState = {
      ...SURAT_TO_ANTWERP_PRESET,
      exchangeRateInr: 83.333,
      freightUsd: 0.01,
      insuranceUsd: 0,
      otherChargesUsd: 0.01,
      items: Array.from({ length: 7 }, (_, index) => ({
        ...SURAT_TO_ANTWERP_PRESET.items[0],
        id: `round-${index}`,
        carats: 1,
        ratePerCarat: 0.07,
        totalAmount: 0.07,
      })),
    };
    const doc = parse(generateTallyPrimeXML(invoice));

    expect(imbalance(doc, 'BASEAMOUNT')).toBe(0);
    expect(ledgerNames(doc)).not.toContain('Marine Transit Insurance (Export)');
  });

  it('escapes XML special characters from user input', () => {
    const invoice: InvoiceState = {
      ...SURAT_TO_ANTWERP_PRESET,
      consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, companyName: 'Smith & "Sons" <BV>' },
      items: [{ ...SURAT_TO_ANTWERP_PRESET.items[0], parcelId: 'A&B<1>', description: "Round 'D' VVS1" }],
    };
    const doc = parse(generateTallyPrimeXML(invoice));

    expect(text(doc, 'PARTYLEDGERNAME')).toBe('Smith & "Sons" <BV>');
    expect(text(doc, 'BATCHNAME')).toBe('LOT-A&B<1>');
    expect(text(doc, 'STOCKITEMNAME')).toBe("Round 'D' VVS1");
  });
});
