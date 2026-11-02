import React, { useState } from 'react';
import { Building, CreditCard, Landmark, Smartphone } from 'lucide-react';
import { api, errorMessage, sendJson, type PortalInvoice, type PortalOrder, type PortalPaymentOptions } from '../../api/client';
import type { BankDetails } from '../../types/invoice';
import { formatUsd } from '../../utils/invoiceDefaults';
import { loadCheckout } from '../../utils/razorpayCheckout';
import { Card, Field, Notice, primaryButton, secondaryButton } from '../../components/ui';

type RazorpayOrderResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };

const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The rupee amount shown before paying. The server works out the exact amount the same way. */
export function inrFor(amountUsd: number, rateInr: number): number {
  return Math.round(amountUsd * rateInr * 100) / 100;
}

/** Reads the USD amount a buyer typed: a number above zero and no more than the balance, else null. */
export function readUsd(text: string, due: number): number | null {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded <= due + 0.001 ? rounded : null;
}

const BANK_ROWS: Array<[keyof BankDetails, string]> = [
  ['bankName', 'Bank'],
  ['branch', 'Branch'],
  ['accountNumber', 'Account number'],
  ['swiftCode', 'SWIFT / BIC'],
  ['ifscCode', 'IFSC (payments from India)'],
  ['iban', 'IBAN'],
  ['correspondentBank', 'Correspondent bank'],
  ['correspondentSwift', 'Correspondent SWIFT'],
];

const today = () => new Date().toISOString().slice(0, 10);

/** Paying one invoice from the buyer portal: online (UPI, card, net banking) or by bank transfer. */
export const PortalPayPanel: React.FC<{
  token: string;
  exporterName: string;
  invoice: PortalInvoice;
  options: PortalPaymentOptions;
  onPaid: (message: string) => void;
  onClose: () => void;
}> = ({ token, exporterName, invoice, options, onPaid, onClose }) => {
  const [amountText, setAmountText] = useState(invoice.dueUsd.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [note, setNote] = useState('');

  const amountUsd = readUsd(amountText, invoice.dueUsd);
  const bank = invoice.invoice.bank;
  const bankRows = BANK_ROWS.filter(([key]) => (bank?.[key] ?? '').toString().trim() !== '');
  const base = `/api/portal/${encodeURIComponent(token)}`;

  const payOnline = async () => {
    if (amountUsd === null) return;
    setBusy(true);
    setError('');
    try {
      const order = await api<PortalOrder>(`${base}/invoices/${invoice.id}/order`, sendJson('POST', { amountUsd }));
      await loadCheckout();
      const checkout = new window.Razorpay!({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.name,
        description: order.description,
        notes: { invoice: invoice.invoiceNumber },
        theme: { color: '#0f172a' },
        handler: async (response: RazorpayOrderResponse) => {
          try {
            await api(`${base}/payments/verify`, sendJson('POST', response));
            onPaid(`Paid ${rupees(order.amountInr)} towards invoice ${invoice.invoiceNumber}. Razorpay will email your receipt.`);
          } catch (err) {
            setError(errorMessage(err, 'The payment went through but could not be confirmed yet. It will show here within a few minutes.'));
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      checkout.on('payment.failed', (response) => {
        setError(response.error?.description ?? 'The payment failed. No money was taken.');
        setBusy(false);
      });
      checkout.open();
    } catch (err) {
      setError(errorMessage(err, err instanceof Error ? err.message : 'Could not start the payment.'));
      setBusy(false);
    }
  };

  const reportTransfer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (amountUsd === null) return;
    setBusy(true);
    setError('');
    try {
      await api(`${base}/invoices/${invoice.id}/claims`, sendJson('POST', { amountUsd, reference, paidOn, note }));
      onPaid(`Thank you. ${exporterName} will confirm the transfer of ${formatUsd(amountUsd)} once it reaches their account.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not send the transfer details.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Pay invoice {invoice.invoiceNumber}</h2>
          <p className="text-xs text-slate-500">Balance due {formatUsd(invoice.dueUsd)}</p>
        </div>
        <button type="button" onClick={onClose} className={secondaryButton}>
          Close
        </button>
      </div>

      <div className="mt-3 max-w-xs">
        <Field label="Amount to pay (USD)" value={amountText} onChange={setAmountText} />
        {amountUsd === null && <p className="mt-1 text-xs text-red-700">Enter an amount above zero and no more than {formatUsd(invoice.dueUsd)}.</p>}
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-stone-200 p-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Smartphone className="w-4 h-4" /> UPI, card or net banking
          </h3>
          {options.online && options.rateInr ? (
            <>
              <p className="mt-1 text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1"><Smartphone className="w-3.5 h-3.5" /> UPI</span>
                <span className="inline-flex items-center gap-1"><CreditCard className="w-3.5 h-3.5" /> Debit and credit cards</span>
                <span className="inline-flex items-center gap-1"><Building className="w-3.5 h-3.5" /> Net banking</span>
              </p>
              <p className="mt-2 text-sm">
                {amountUsd === null ? '—' : <strong className="tabular-nums">{rupees(inrFor(amountUsd, options.rateInr))}</strong>}
                <span className="text-xs text-slate-500"> at ₹{options.rateInr} per USD ({options.rateSource})</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Paid in Indian rupees, straight to {exporterName}&apos;s account through Razorpay. Your card or UPI details go to Razorpay only.
              </p>
              {options.testMode && <p className="mt-1 text-xs font-semibold text-amber-800">Test mode: no real money moves.</p>}
              <button type="button" disabled={busy || amountUsd === null} onClick={payOnline} className={`${primaryButton} mt-3`}>
                {busy ? 'Opening payment…' : 'Pay now'}
              </button>
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-500">{exporterName} has not switched on online payment. Pay by bank transfer instead.</p>
          )}
        </section>

        <section className="rounded-lg border border-stone-200 p-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Landmark className="w-4 h-4" /> Bank transfer (SWIFT, NEFT, RTGS)
          </h3>
          {bankRows.length > 0 ? (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-500">Beneficiary</dt>
              <dd className="font-semibold">{invoice.invoice.exporter?.companyName || exporterName}</dd>
              {bankRows.map(([key, label]) => (
                <React.Fragment key={key}>
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="font-mono break-all">{String(bank[key])}</dd>
                </React.Fragment>
              ))}
              <dt className="text-slate-500">Reference</dt>
              <dd className="font-mono">{invoice.invoiceNumber}</dd>
            </dl>
          ) : (
            <p className="mt-1 text-sm text-slate-500">Ask {exporterName} for their bank details.</p>
          )}
          {invoice.claimPending ? (
            <p className="mt-3 text-sm text-slate-600">You have reported a transfer for this invoice. {exporterName} will confirm it once it arrives.</p>
          ) : (
            <form onSubmit={reportTransfer} className="mt-3 space-y-2">
              <p className="text-xs text-slate-500">Already sent it? Tell {exporterName} so they can match it.</p>
              <Field label="Bank reference (UTR or SWIFT / MT103 reference)" value={reference} onChange={setReference} required minLength={4} />
              <Field label="Date sent" type="date" value={paidOn} onChange={setPaidOn} required />
              <Field label="Note (optional)" value={note} onChange={setNote} />
              <button type="submit" disabled={busy || amountUsd === null || reference.trim().length < 4} className={secondaryButton}>
                I have sent {amountUsd === null ? 'the transfer' : formatUsd(amountUsd)}
              </button>
            </form>
          )}
        </section>
      </div>
    </Card>
  );
};
