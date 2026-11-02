import React, { useState } from 'react';
import { api, errorMessage, sendJson, type IncomingPayments as Incoming, type PaymentClaim } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Badge, TableHead, cell, useReport } from '../../components/shared';
import { Card, Field, Notice, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

const METHOD: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI' };
const STATUS_TONE: Record<PaymentClaim['status'], 'amber' | 'green' | 'slate'> = { submitted: 'amber', confirmed: 'green', rejected: 'slate' };
const STATUS_LABEL: Record<PaymentClaim['status'], string> = { submitted: 'To check', confirmed: 'Confirmed', rejected: 'Rejected' };

/** Confirming a reported transfer: the amount actually credited (after bank charges) and the bank's rate. */
const ConfirmForm: React.FC<{ claim: PaymentClaim; onDone: () => void; onCancel: () => void }> = ({ claim, onDone, onCancel }) => {
  const [amountUsd, setAmountUsd] = useState(claim.amountUsd.toFixed(2));
  const [paidOn, setPaidOn] = useState(claim.paidOn);
  const [bankRateInr, setBankRateInr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/collections/claims/${claim.id}/confirm`, sendJson('POST', { amountUsd, paidOn, bankRateInr }));
      onDone();
    } catch (err) {
      setError(errorMessage(err, 'Could not record the payment.'));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-2 grid gap-2 sm:grid-cols-4 items-end rounded-lg border border-stone-200 bg-slate-50 p-3">
      <Field label="Amount credited (USD)" value={amountUsd} onChange={setAmountUsd} required />
      <Field label="Date credited" type="date" value={paidOn} onChange={setPaidOn} required />
      <Field label="Bank rate ₹/USD (optional)" value={bankRateInr} onChange={setBankRateInr} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Recording…' : 'Record payment'}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="sm:col-span-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </form>
  );
};

/** Payments buyers made from their portal: bank transfers to confirm, and online payments already recorded. */
export const IncomingPayments: React.FC<{ canConfirm: boolean }> = ({ canConfirm }) => {
  const { data, error, setError, reload } = useReport<Incoming>('/api/collections/incoming', 'Could not load payments from buyers.');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const reject = async (claim: PaymentClaim) => {
    const note = window.prompt(`Reject the transfer ${claim.reference}? Add a note for your records (optional).`, 'Not received');
    if (note === null) return;
    try {
      await api(`/api/collections/claims/${claim.id}/reject`, sendJson('POST', { note }));
      setMessage(`Rejected ${claim.reference}.`);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not reject the transfer.'));
    }
  };

  if (!data || (data.claims.length === 0 && data.online.length === 0)) {
    return error ? <Notice tone="error">{error}</Notice> : null;
  }
  const unrecorded = data.online.filter((payment) => !payment.recorded);

  return (
    <Card title="Payments from buyers">
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {unrecorded.length > 0 && (
        <Notice tone="error">
          {unrecorded.length === 1 ? 'One online payment was' : `${unrecorded.length} online payments were`} received but not recorded on the invoice (
          {unrecorded[0].recordError}). The money is in your Razorpay account; record it by hand under the invoice&apos;s payments.
        </Notice>
      )}

      {data.claims.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Bank transfers reported by buyers</h3>
          <ul className="mt-1 divide-y divide-stone-100">
            {data.claims.map((claim) => (
              <li key={claim.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Badge tone={STATUS_TONE[claim.status]}>{STATUS_LABEL[claim.status]}</Badge>
                  <span className="font-semibold">{claim.invoiceNumber}</span>
                  <span>{claim.buyerName}</span>
                  <span className="tabular-nums">{formatUsd(claim.amountUsd)}</span>
                  <span className="text-slate-500">sent {claim.paidOn}</span>
                  <span className="font-mono text-xs">{claim.reference}</span>
                  {claim.payerNote && <span className="text-slate-500">“{claim.payerNote}”</span>}
                  {claim.status === 'rejected' && claim.reviewNote && <span className="text-slate-500">({claim.reviewNote})</span>}
                  {canConfirm && claim.status === 'submitted' && confirming !== claim.id && (
                    <span className="ml-auto flex gap-2">
                      <button type="button" onClick={() => setConfirming(claim.id)} className={primaryButton}>
                        Money arrived
                      </button>
                      <button type="button" onClick={() => reject(claim)} className={dangerButton}>
                        Reject
                      </button>
                    </span>
                  )}
                </div>
                {confirming === claim.id && (
                  <ConfirmForm
                    claim={claim}
                    onCancel={() => setConfirming(null)}
                    onDone={() => {
                      setConfirming(null);
                      setMessage(`Recorded the payment on ${claim.invoiceNumber}.`);
                      reload();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {data.online.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Paid online</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Date', 'Invoice', 'Buyer', 'USD', 'INR', 'Method', 'Razorpay ID', '']} />
              <tbody>
                {data.online.map((payment) => (
                  <tr key={payment.id}>
                    <td className={`${cell} whitespace-nowrap`}>{new Date(payment.paidAt).toLocaleDateString()}</td>
                    <td className={`${cell} font-semibold`}>{payment.invoiceNumber}</td>
                    <td className={cell}>{payment.buyerName}</td>
                    <td className={`${cell} tabular-nums`}>{formatUsd(payment.amountUsd)}</td>
                    <td className={`${cell} tabular-nums`}>₹{payment.amountInr.toLocaleString('en-IN')}</td>
                    <td className={cell}>{METHOD[payment.method] ?? payment.method}</td>
                    <td className={`${cell} font-mono text-xs`}>{payment.razorpayPaymentId}</td>
                    <td className={cell}>
                      <Badge tone={payment.recorded ? 'green' : 'red'}>{payment.recorded ? 'Recorded' : 'Not recorded'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
};
