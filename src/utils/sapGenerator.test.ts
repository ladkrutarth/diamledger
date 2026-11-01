import { describe, expect, it } from 'vitest';
import { MUMBAI_TO_NY_PRESET, SURAT_TO_ANTWERP_PRESET, SURAT_TO_DUBAI_PRESET } from '../data/sampleInvoices';
import type { InvoiceState } from '../types/invoice';
import { generateSapODataPayload } from './sapGenerator';

describe('generateSapODataPayload', () => {
  it.each([
    ['Surat to Antwerp', SURAT_TO_ANTWERP_PRESET],
    ['Mumbai to New York', MUMBAI_TO_NY_PRESET],
    ['Surat to Dubai', SURAT_TO_DUBAI_PRESET],
  ])('builds an export sales order for %s', (_name, invoice) => {
    const { d } = generateSapODataPayload(invoice);
    const total =
      invoice.items.reduce((sum, item) => sum + item.totalAmount, 0) +
      invoice.freightUsd +
      invoice.insuranceUsd +
      invoice.otherChargesUsd;

    expect(d.SalesOrderType).toBe('OR_EXP');
    expect(d.TransactionCurrency).toBe('USD');
    expect(d.TotalNetAmount).toBe(total.toFixed(2));
    expect(d.PricingDate).toBe(invoice.shipment.invoiceDate);
    expect(d.ReferenceSDDocument).toBe(invoice.shipment.invoiceNumber);
    expect(d.IncotermsClassification).toBe(invoice.shipment.incoterms);
    expect(d.AccountingExchangeRate).toBe(invoice.exchangeRateInr.toFixed(2));
    expect(d.to_Item).toHaveLength(invoice.items.length);
    expect(d.to_Text[0].LongText).toContain(`LUT ARN: ${invoice.shipment.lutNumber}`);
    expect(d.to_Text[0].LongText).toContain(`KPCS: ${invoice.shipment.kpcsNumber}`);
  });

  it('numbers items in steps of ten and converts carats to grams', () => {
    const { d } = generateSapODataPayload(SURAT_TO_ANTWERP_PRESET);
    const source = SURAT_TO_ANTWERP_PRESET.items;

    expect(d.to_Item.map((item) => item.SalesOrderItem)).toEqual(
      source.map((_item, index) => String((index + 1) * 10).padStart(6, '0')),
    );
    const [first] = d.to_Item;
    expect(first.RequestedQuantity).toBe(source[0].carats.toFixed(3));
    expect(first.AlternativeItemGrossWeight).toBe((source[0].carats * 0.2).toFixed(4));
    expect(first.NetPriceAmount).toBe(source[0].ratePerCarat.toFixed(2));
    expect(first.Material).toBe(`DIAMOND-7102-${source[0].hsCode.replace(/\./g, '')}`);
    expect(first.Batch).toBe(source[0].parcelId);
    expect(first.to_PricingElement.map((element) => element.ConditionType)).toEqual(['PR00', 'ZEXP']);
    expect(first.to_PricingElement[1].ConditionRateValue).toBe('0.00');
  });

  it('sends the buyer as sold-to and ship-to party and the carrier with its AWB', () => {
    const { d } = generateSapODataPayload(MUMBAI_TO_NY_PRESET);
    const [soldTo, shipTo, carrier] = d.to_Partner;

    expect(soldTo).toMatchObject({ PartnerFunction: 'SP', FullName: MUMBAI_TO_NY_PRESET.consignee.companyName });
    expect(shipTo).toMatchObject({ PartnerFunction: 'SH', Country: MUMBAI_TO_NY_PRESET.consignee.country });
    expect(carrier).toMatchObject({
      PartnerFunction: 'CR',
      FullName: MUMBAI_TO_NY_PRESET.shipment.carrierName,
      ReferenceIdentifier: MUMBAI_TO_NY_PRESET.shipment.awbNumber,
    });
  });

  it('falls back to default identifiers when optional fields are blank', () => {
    const invoice: InvoiceState = {
      ...SURAT_TO_ANTWERP_PRESET,
      consignee: { ...SURAT_TO_ANTWERP_PRESET.consignee, taxIdVat: '' },
      shipment: { ...SURAT_TO_ANTWERP_PRESET.shipment, buyerOrderRef: '' },
      items: [{ ...SURAT_TO_ANTWERP_PRESET.items[0], parcelId: '', certificateNo: '' }],
    };
    const { d } = generateSapODataPayload(invoice);

    expect(d.to_Partner[0].Customer).toBe('CUST-OVERSEAS-01');
    expect(d.PurchaseOrderByCustomer).toBe(invoice.shipment.invoiceNumber);
    expect(d.to_Item[0].Batch).toBe('LOT-1');
    expect(d.to_Item[0].CertificateNumber).toBe('N/A');
  });
});
