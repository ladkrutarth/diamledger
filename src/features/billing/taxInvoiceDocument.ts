import { api, errorMessage, type SubscriptionTaxInvoice } from '../../api/client';

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function formatMoney(value: number, currency: 'INR' | 'USD'): string {
  const text = value.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'INR' ? `₹${text}` : `$${text}`;
}

/** The tax invoice as a standalone, printable HTML page. Every value is escaped. */
export function taxInvoiceHtml(invoice: SubscriptionTaxInvoice): string {
  const money = (value: number) => escapeHtml(formatMoney(value, invoice.currency));
  const party = (title: string, p: SubscriptionTaxInvoice['seller'] & { country?: string }) => `
    <div class="party">
      <h3>${escapeHtml(title)}</h3>
      <p class="name">${escapeHtml(p.name)}</p>
      ${p.address ? `<p>${escapeHtml(p.address)}</p>` : ''}
      <p>${escapeHtml([p.state, p.country && p.country !== 'India' ? p.country : ''].filter(Boolean).join(', '))}${p.stateCode ? ` (State code ${escapeHtml(p.stateCode)})` : ''}</p>
      <p>GSTIN: ${p.gstin ? escapeHtml(p.gstin) : 'Unregistered'}</p>
    </div>`;
  const taxRows = [
    invoice.cgst || invoice.sgst
      ? `<tr><td colspan="3">CGST @ ${invoice.cgstRate}%</td><td class="num">${money(invoice.cgst)}</td></tr>
         <tr><td colspan="3">SGST @ ${invoice.sgstRate}%</td><td class="num">${money(invoice.sgst)}</td></tr>`
      : '',
    invoice.igst ? `<tr><td colspan="3">IGST @ ${invoice.igstRate}%</td><td class="num">${money(invoice.igst)}</td></tr>` : '',
  ].join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Tax invoice ${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  body { font: 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; color: #111; margin: 32px auto; max-width: 760px; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0; } h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #555; margin: 0 0 4px; }
  p { margin: 1px 0; } .name { font-weight: 600; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .meta { text-align: right; } .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; } th, td { border-bottom: 1px solid #ddd; padding: 6px 4px; text-align: left; }
  th { font-size: 11px; color: #555; text-transform: uppercase; } .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; } .foot { margin-top: 20px; color: #444; font-size: 12px; }
  .print { margin-top: 24px; } @media print { .print { display: none; } body { margin: 0 auto; } }
</style></head><body>
  <div class="head">
    <div><h1>Tax invoice</h1><p>Original for recipient</p></div>
    <div class="meta">
      <p><strong>${escapeHtml(invoice.invoiceNumber)}</strong></p>
      <p>Date: ${escapeHtml(invoice.invoiceDate)}</p>
      <p>Place of supply: ${escapeHtml(invoice.placeOfSupply)}</p>
      <p>Reverse charge: ${invoice.reverseCharge ? 'Yes' : 'No'}</p>
    </div>
  </div>
  <div class="parties">${party('Supplier', invoice.seller)}${party('Recipient', invoice.buyer)}</div>
  <table>
    <thead><tr><th>Description</th><th>SAC</th><th class="num">Qty</th><th class="num">Taxable value</th></tr></thead>
    <tbody>
      ${invoice.lines
        .map((line) => `<tr><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.sac)}</td><td class="num">${line.quantity}</td><td class="num">${money(line.taxableValue)}</td></tr>`)
        .join('')}
      <tr><td colspan="3">Taxable value</td><td class="num">${money(invoice.taxableValue)}</td></tr>
      ${taxRows}
      <tr class="total"><td colspan="3">Total (${escapeHtml(invoice.currency)})</td><td class="num">${money(invoice.total)}</td></tr>
    </tbody>
  </table>
  <div class="foot">
    <p>Paid on ${escapeHtml(new Date(invoice.payment.paidAt).toLocaleDateString('en-IN'))} · payment reference ${escapeHtml(invoice.payment.id)}</p>
    ${invoice.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}
    <p>This is a computer-generated invoice and needs no signature.</p>
  </div>
  <p class="print">To keep a copy, print this page or choose “Save as PDF” in the print dialog.</p>
</body></html>`;
}

/** Opens the tax invoice in a new tab, ready to print or save as PDF. The tab is opened before the request so
 * pop-up blockers allow it. */
export async function openTaxInvoice(invoiceId: string): Promise<string | null> {
  const tab = window.open('', '_blank');
  try {
    const invoice = await api<SubscriptionTaxInvoice>(`/api/billing/invoices/${encodeURIComponent(invoiceId)}`);
    if (!tab) return 'Allow pop-ups for this site to open the invoice.';
    tab.document.open();
    tab.document.write(taxInvoiceHtml(invoice));
    tab.document.close();
    // The tab inherits this page's Content Security Policy, so it cannot run its own script; print from here.
    tab.focus();
    tab.print();
    return null;
  } catch (err) {
    tab?.close();
    return errorMessage(err, 'Could not open the invoice.');
  }
}
