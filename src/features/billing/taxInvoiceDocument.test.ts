import { describe, expect, it } from 'vitest';
import type { SubscriptionTaxInvoice } from '../../api/client';
import { formatMoney, taxInvoiceHtml } from './taxInvoiceDocument';

const base: SubscriptionTaxInvoice = {
  id: 'inv-1',
  invoiceNumber: 'DX/2026-27/00001',
  financialYear: '2026-27',
  invoiceDate: '2026-11-02',
  seller: { name: 'DiamondX Software Pvt Ltd', gstin: '24AAACD1234E1Z5', address: 'Surat', state: 'Gujarat', stateCode: '24' },
  buyer: { name: 'Surat Gems', gstin: '24AABCM5678F1Z2', address: 'Ring Road', state: 'Gujarat', stateCode: '24', country: 'India' },
  placeOfSupply: '24 - Gujarat',
  reverseCharge: false,
  currency: 'INR',
  lines: [{ description: 'DiamondX Growth plan, monthly subscription', sac: '997331', quantity: 1, taxableValue: 3999.15 }],
  taxableValue: 3999.15,
  cgstRate: 9,
  cgst: 359.92,
  sgstRate: 9,
  sgst: 359.93,
  igstRate: 0,
  igst: 0,
  total: 4719,
  payment: { id: 'pay_1', provider: 'razorpay', method: 'upi', paidAt: '2026-11-02T06:00:00.000Z' },
  notes: [],
};

describe('taxInvoiceHtml', () => {
  it('shows both GSTINs, the SAC code, and CGST plus SGST within a state', () => {
    const html = taxInvoiceHtml(base);
    for (const text of ['DX/2026-27/00001', '24AAACD1234E1Z5', '24AABCM5678F1Z2', '997331', 'CGST @ 9%', 'SGST @ 9%', '₹4,719.00', '24 - Gujarat']) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('IGST @');
  });

  it('shows IGST alone between states', () => {
    const html = taxInvoiceHtml({ ...base, cgst: 0, sgst: 0, cgstRate: 0, sgstRate: 0, igst: 719.85, igstRate: 18, placeOfSupply: '27 - Maharashtra' });
    expect(html).toContain('IGST @ 18%');
    expect(html).not.toContain('CGST @');
  });

  it('escapes everything that came from a company profile', () => {
    const html = taxInvoiceHtml({ ...base, buyer: { ...base.buyer, name: '<img src=x onerror=alert(1)>', gstin: '' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('GSTIN: Unregistered');
  });

  it('has no inline script, which the Content Security Policy would block', () => {
    expect(taxInvoiceHtml(base)).not.toMatch(/<script|onclick=|onload=/i);
  });
});

describe('formatMoney', () => {
  it('formats rupees the Indian way and dollars the US way', () => {
    expect(formatMoney(123456.5, 'INR')).toBe('₹1,23,456.50');
    expect(formatMoney(123456.5, 'USD')).toBe('$123,456.50');
  });
});
