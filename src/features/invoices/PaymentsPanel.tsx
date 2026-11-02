import React, { useEffect, useState } from 'react';
import { api, errorMessage, sendJson, type InvoiceStatus, type PaymentState } from '../../api/client';
import { formatUsd, todayIso } from '../../utils/invoiceDefaults';
import { Field, Notice, dangerButton, primaryButton } from '../../components/ui';

interface Props {
  invoiceId: string | null;
  status: InvoiceStatus;
  isAdmin: boolean;
  readOnly?: boolean;
  onChanged: () => void;
}

export const PaymentsPanel: React.FC<Props> = ({ invoiceId, status, isAdmin, readOnly = false, onChanged }) => {
  const [state, setState] = useState<PaymentState | null>(null);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [bankRate, setBankRate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(null);
    setError('');
    if (!invoiceId) return;
    api<PaymentState>(`/api/invoices/${invoiceId}/payments`)
      .then(setState)
      .catch((err) => setError(errorMessage(err, 'Could not load payments.')));
  }, [invoiceId, status]);

  if (!invoiceId) {
    return <div className="p-4"><Notice>Save the invoice first, then issue it to record payments.</Notice></div>;
  }

  const canRecord = !readOnly && (status === 'issued' || status === 'paid');

  const record = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = await api<PaymentState>(
        `/api/invoices/${invoiceId}/payments`,
        sendJson('POST', { amountUsd: Number(amount), paidOn, reference, bankRateInr: bankRate.trim() }),
      );
      setState(next);
      setAmount('');
      setReference('');
      setBankRate('');
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not record the payment.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (paymentId: string) => {
    if (!window.confirm('Delete this payment?')) return;
    setError('');
    try {
      setState(await api<PaymentState>(`/api/invoices/${invoiceId}/payments/${paymentId}`, sendJson('DELETE')));
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the payment.'));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-sm">
      {state && (
        <div className="grid grid-cols-3 gap-2">
          {[
            ['Invoice total', state.totalUsd],
            ['Received', state.paidUsd],
            ['Balance due', state.dueUsd],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold text-slate-500">{label}</p>
              <p className="text-base font-bold text-slate-950">{formatUsd(value as number)}</p>
            </div>
          ))}
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {canRecord ? (
        <form onSubmit={record} className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3">
          <Field label="Amount received (USD)" type="number" value={amount} onChange={setAmount} required />
          <Field label="Date received" type="date" value={paidOn} onChange={setPaidOn} required />
          <div className="col-span-2">
            <Field label="Bank reference / SWIFT message" value={reference} onChange={setReference} />
          </div>
          <div className="col-span-2">
            <Field label="Bank rate (₹ per USD, for exchange gain or loss)" type="number" value={bankRate} onChange={setBankRate} />
          </div>
          <div className="col-span-2">
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy ? 'Saving...' : 'Record payment'}
            </button>
          </div>
        </form>
      ) : (
        <Notice>
          {status === 'cancelled'
            ? 'This invoice is cancelled, so payments cannot be recorded.'
            : 'Issue this invoice to start recording payments against it.'}
        </Notice>
      )}

      <div>
        <h3 className="text-xs font-semibold text-slate-700 mb-2">Payments received</h3>
        {state && state.payments.length === 0 && <p className="text-xs text-slate-500">No payments recorded yet.</p>}
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
          {state?.payments.map((payment) => (
            <li key={payment.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div>
                <p className="font-semibold text-slate-900">{formatUsd(payment.amountUsd)}</p>
                <p className="text-xs text-slate-500">
                  {payment.paidOn}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                  {payment.bankRateInr ? ` · ₹${payment.bankRateInr}/USD` : ''}
                </p>
              </div>
              {isAdmin && (
                <button type="button" onClick={() => remove(payment.id)} className={dangerButton}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
