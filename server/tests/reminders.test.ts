import { describe, expect, it } from 'vitest';
import { reminderSubject, reminderTone, renderReminderHtml, templateReminderText, type ReminderFigures } from '../modules/collections/reminders.js';

const figures: ReminderFigures = {
  invoiceNumber: 'EXP/2026-27/0007',
  invoiceDate: '2026-09-01',
  dueDate: '2026-10-01',
  daysOverdue: 31,
  totalUsd: 125000,
  paidUsd: 25000.5,
  dueUsd: 99999.5,
  paymentTerms: 'T/T within 30 days',
  exporterName: 'xyz LLC',
  signatoryName: 'A. Shah',
  signatoryDesignation: '',
  bank: { bankName: 'HDFC <Bank>', accountNumber: '123', swiftCode: '', iban: '' },
};

describe('payment reminders', () => {
  it('escalates tone with days overdue and reminders already sent', () => {
    expect(reminderTone(5, 0)).toBe('gentle');
    expect(reminderTone(22, 0)).toBe('firm');
    expect(reminderTone(5, 1)).toBe('firm');
    expect(reminderTone(61, 0)).toBe('final');
    expect(reminderTone(5, 2)).toBe('final');
  });

  it('renders figures from the invoice, escapes text, and skips empty rows', () => {
    const text = { ...templateReminderText({ buyerName: 'B&B', contactPerson: '', exporterName: 'xyz LLC', tone: 'gentle' }) };
    const html = renderReminderHtml(text, figures);
    expect(html).toContain('Dear B&amp;B,');
    expect(html).toContain('$99,999.50');
    expect(html).toContain('HDFC &lt;Bank&gt;');
    expect(html).not.toContain('SWIFT');
    expect(html).toContain('A. Shah<br />xyz LLC');
  });

  it('keeps the subject on one line and appends the invoice number', () => {
    expect(reminderSubject('Payment\r\nreminder', 'EXP-1')).toBe('Payment reminder - Invoice EXP-1');
  });
});
