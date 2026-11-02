import React, { useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { api, errorMessage, sendJson, type ForeignPayment, type ForeignPaymentReport } from '../../api/client';
import { Card, Field, Notice, dangerButton, primaryButton, secondaryButton } from '../../components/ui';
import { Badge, CheckField, SelectField, Stat, TableHead, YearField, cell, financialYearOf, formatInr, useReport } from '../../components/shared';

const NATURES: Array<[ForeignPayment['nature'], string]> = [
  ['commission', 'Commission to an agent or broker'],
  ['freight', 'Freight or courier'],
  ['professional', 'Professional or technical fees'],
  ['royalty', 'Royalty'],
  ['interest', 'Interest'],
  ['other', 'Other'],
];

type Form = {
  id: string | null;
  payeeName: string;
  payeeCountry: string;
  nature: ForeignPayment['nature'];
  paidOn: string;
  currency: string;
  amountFc: string;
  rateInr: string;
  taxableInIndia: boolean;
  tdsRate: string;
  tdsInr: string;
  dtaaApplied: boolean;
  trcReceived: boolean;
  form15caAck: string;
  form15cbNo: string;
  relatedParty: boolean;
  reference: string;
  notes: string;
};

const blank = (): Form => ({
  id: null, payeeName: '', payeeCountry: '', nature: 'commission', paidOn: new Date().toISOString().slice(0, 10), currency: 'USD', amountFc: '',
  rateInr: '', taxableInIndia: true, tdsRate: '', tdsInr: '', dtaaApplied: false, trcReceived: false, form15caAck: '', form15cbNo: '',
  relatedParty: false, reference: '', notes: '',
});

export const ForeignPaymentsDesk: React.FC<{ canWrite: boolean; canManage: boolean }> = ({ canWrite, canManage }) => {
  const [year, setYear] = useState(financialYearOf());
  const { data, error, setError, reload } = useReport<ForeignPaymentReport>(`/api/foreign-payments?year=${year}`, 'Could not load payments abroad.');
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => form && setForm({ ...form, [key]: value });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const body = { ...form, tdsInr: form.tdsInr === '' ? null : form.tdsInr };
      await api(form.id ? `/api/foreign-payments/${form.id}` : '/api/foreign-payments', sendJson(form.id ? 'PUT' : 'POST', body));
      setForm(null);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the payment.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (payment: ForeignPayment) => {
    if (!window.confirm(`Delete the payment to ${payment.payeeName} on ${payment.paidOn}?`)) return;
    try {
      await api(`/api/foreign-payments/${payment.id}`, sendJson('DELETE'));
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the payment.'));
    }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-40">
            <YearField value={year} onChange={setYear} />
          </div>
          <div className="flex gap-2">
            <a href={`/api/foreign-payments/csv?year=${year}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
            {canWrite && (
              <button type="button" onClick={() => setForm(blank())} className={primaryButton}>
                <Plus className="w-3.5 h-3.5" />
                Record payment abroad
              </button>
            )}
          </div>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Stat label="Paid abroad" value={formatInr(data.totals.amountInr)} />
            <Stat label="TDS deducted" value={formatInr(data.totals.tdsInr)} />
            <Stat label="Taxable, no TDS" value={data.totals.withoutTds} tone={data.totals.withoutTds ? 'red' : undefined} />
            <Stat label="15CA not recorded" value={data.totals.missing15ca} tone={data.totals.missing15ca ? 'amber' : undefined} />
            <Stat label="15CB needed, missing" value={data.totals.missing15cb} tone={data.totals.missing15cb ? 'red' : undefined} />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Brokerage, freight, lab fees, and other payments to parties outside India. Each payment shows which part of Form 15CA usually
          applies: Part D when not taxable in India, Part A up to ₹5 lakh to the payee in the year, and Part C (with a CA's Form 15CB) above
          that. Part B, for a lower-deduction order, is left to your accountant. Whether a payment is taxable in India and the treaty rate
          are your accountant's call; this keeps the record and flags gaps.
        </p>
      </Card>

      {form && (
        <Card title={form.id ? `Edit payment to ${form.payeeName}` : 'Record a payment abroad'}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="Paid to" value={form.payeeName} required onChange={(value) => set('payeeName', value)} />
            <Field label="Country" value={form.payeeCountry} onChange={(value) => set('payeeCountry', value)} />
            <SelectField label="Nature" value={form.nature} options={NATURES} onChange={(value) => set('nature', value as Form['nature'])} />
            <Field label="Paid on" type="date" value={form.paidOn} required onChange={(value) => set('paidOn', value)} />
            <Field label="Currency" value={form.currency} onChange={(value) => set('currency', value.toUpperCase())} />
            <Field label="Amount" value={form.amountFc} required onChange={(value) => set('amountFc', value)} />
            <Field label="Rate (₹ per unit)" value={form.rateInr} required onChange={(value) => set('rateInr', value)} />
            <CheckField label="Taxable in India" checked={form.taxableInIndia} onChange={(value) => set('taxableInIndia', value)} />
            <Field label="TDS rate %" value={form.tdsRate} onChange={(value) => set('tdsRate', value)} />
            <Field label="TDS deducted (₹)" value={form.tdsInr} placeholder="Worked out from the rate if blank" onChange={(value) => set('tdsInr', value)} />
            <CheckField label="Treaty (DTAA) rate used" checked={form.dtaaApplied} onChange={(value) => set('dtaaApplied', value)} />
            <CheckField label="Tax Residency Certificate received" checked={form.trcReceived} onChange={(value) => set('trcReceived', value)} />
            <Field label="Form 15CA acknowledgement" value={form.form15caAck} onChange={(value) => set('form15caAck', value)} />
            <Field label="Form 15CB certificate no" value={form.form15cbNo} onChange={(value) => set('form15cbNo', value)} />
            <Field label="Bank reference" value={form.reference} onChange={(value) => set('reference', value)} />
            <CheckField label="Related party" checked={form.relatedParty} onChange={(value) => set('relatedParty', value)} />
            <div className="md:col-span-4">
              <Field label="Notes" value={form.notes} onChange={(value) => set('notes', value)} />
            </div>
            <div className="md:col-span-4 flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save payment'}
              </button>
              <button type="button" onClick={() => setForm(null)} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : data.payments.length === 0 ? (
          <p className="text-sm text-slate-500">No payments abroad in {year}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Paid to', 'Amount', 'TDS', '15CA / 15CB', 'Checks', '']} />
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className={cell}>
                      <p className="font-semibold">{payment.payeeName}</p>
                      <p className="text-xs text-slate-500">
                        {payment.paidOn} · {payment.nature}
                        {payment.payeeCountry ? ` · ${payment.payeeCountry}` : ''}
                        {payment.relatedParty ? ' · related party' : ''}
                      </p>
                    </td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>
                      {formatInr(payment.amountInr)}
                      <p className="text-xs text-slate-500">
                        {payment.currency} {payment.amountFc.toFixed(2)} @ {payment.rateInr}
                      </p>
                    </td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>
                      {payment.taxableInIndia ? formatInr(payment.tdsInr) : 'Not taxable'}
                      {payment.tdsRate > 0 && <p className="text-xs text-slate-500">{payment.tdsRate}%{payment.dtaaApplied ? ' (DTAA)' : ''}</p>}
                    </td>
                    <td className={cell}>
                      <Badge tone="slate">Part {payment.form15caPart}</Badge>
                      <p className="text-xs text-slate-500 mt-1">{payment.form15caAck || 'No 15CA ack'}</p>
                      {payment.form15caPart === 'C' && <p className="text-xs text-slate-500">{payment.form15cbNo || 'No 15CB'}</p>}
                    </td>
                    <td className={cell}>
                      {payment.issues.length === 0 ? (
                        <Badge tone="green">OK</Badge>
                      ) : (
                        <ul className="space-y-0.5">
                          {payment.issues.map((issue) => (
                            <li key={issue.text} className={`text-xs ${issue.tone === 'red' ? 'text-red-700' : 'text-amber-800'}`}>
                              {issue.text}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={`${cell} text-right whitespace-nowrap`}>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              ...payment,
                              amountFc: String(payment.amountFc),
                              rateInr: String(payment.rateInr),
                              tdsRate: payment.tdsRate ? String(payment.tdsRate) : '',
                              tdsInr: String(payment.tdsInr),
                            })
                          }
                          className={secondaryButton}
                        >
                          Edit
                        </button>
                      )}
                      {canManage && (
                        <button type="button" onClick={() => remove(payment)} className={`${dangerButton} ml-2`}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};
