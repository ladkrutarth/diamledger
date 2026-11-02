import React, { useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { api, errorMessage, sendJson, type TaxNotice } from '../../api/client';
import { Card, Field, Notice, dangerButton, primaryButton, secondaryButton } from '../../components/ui';
import { Badge, SelectField, TextAreaField, formatInr, useReport } from '../../components/shared';

const AUTHORITIES: Array<[TaxNotice['authority'], string]> = [
  ['gst', 'GST department'],
  ['income_tax', 'Income Tax department'],
  ['customs', 'Customs'],
  ['dgft', 'DGFT'],
  ['rbi', 'RBI / AD bank'],
  ['other', 'Other authority'],
];

type Form = {
  id: string | null;
  authority: TaxNotice['authority'];
  formType: string;
  referenceNo: string;
  period: string;
  issuedOn: string;
  replyDue: string;
  amountInr: string;
  status: TaxNotice['status'];
  summary: string;
  reply: string;
  invoiceNumbers: string;
};

const blank = (): Form => ({
  id: null, authority: 'gst', formType: '', referenceNo: '', period: '', issuedOn: '', replyDue: '', amountInr: '', status: 'open',
  summary: '', reply: '', invoiceNumbers: '',
});

const toForm = (notice: TaxNotice): Form => ({
  id: notice.id,
  authority: notice.authority,
  formType: notice.formType,
  referenceNo: notice.referenceNo,
  period: notice.period,
  issuedOn: notice.issuedOn ?? '',
  replyDue: notice.replyDue ?? '',
  amountInr: notice.amountInr === null ? '' : String(notice.amountInr),
  status: notice.status,
  summary: notice.summary,
  reply: notice.reply,
  invoiceNumbers: notice.invoiceNumbers.join(', '),
});

function dueLabel(notice: TaxNotice): React.ReactNode {
  if (notice.status !== 'open') return <Badge tone="slate">{notice.status === 'replied' ? 'Replied' : 'Closed'}</Badge>;
  if (notice.daysLeft === null) return <Badge tone="slate">No due date</Badge>;
  if (notice.daysLeft < 0) return <Badge tone="red">{-notice.daysLeft} days overdue</Badge>;
  if (notice.daysLeft <= 7) return <Badge tone="amber">Due in {notice.daysLeft} days</Badge>;
  return <Badge tone="green">Due in {notice.daysLeft} days</Badge>;
}

export const NoticesDesk: React.FC<{ canDelete: boolean }> = ({ canDelete }) => {
  const { data, error, setError, reload } = useReport<{ notices: TaxNotice[] }>('/api/notices', 'Could not load notices.');
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const set = <K extends keyof Form>(key: K, value: Form[K]) => form && setForm({ ...form, [key]: value });

  const persist = async (current: Form): Promise<string> => {
    const body = { ...current, invoiceNumbers: current.invoiceNumbers, amountInr: current.amountInr === '' ? null : current.amountInr };
    if (current.id) {
      await api(`/api/notices/${current.id}`, sendJson('PUT', body));
      return current.id;
    }
    const created = await api<{ id: string }>('/api/notices', sendJson('POST', body));
    return created.id;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      await persist(form);
      setForm(null);
      setNote('');
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the notice.'));
    } finally {
      setBusy(false);
    }
  };

  const draft = async () => {
    if (!form) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const id = await persist(form);
      const result = await api<{ reply: string; source: string; note: string }>(`/api/notices/${id}/draft-reply`, sendJson('POST'));
      setForm({ ...form, id, reply: result.reply });
      setNote(result.note || 'Drafted by AI from the notice and the linked invoices. Check every fact before sending.');
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not draft a reply.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (notice: TaxNotice) => {
    if (!window.confirm(`Delete ${notice.formType} ${notice.referenceNo}?`)) return;
    try {
      await api(`/api/notices/${notice.id}`, sendJson('DELETE'));
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the notice.'));
    }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600 max-w-2xl">
            Log every notice from GST, Income Tax, Customs, DGFT, or the bank with its reply date, link the invoices it is about, and draft a
            reply from those invoices' shipping bills and bank realization. The draft only uses figures from your records; nothing is sent.
          </p>
          <button type="button" onClick={() => { setForm(blank()); setNote(''); }} className={primaryButton}>
            <Plus className="w-3.5 h-3.5" />
            Log a notice
          </button>
        </div>
      </Card>

      {form && (
        <Card title={form.id ? `${form.formType} ${form.referenceNo}` : 'Log a notice'}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <SelectField label="From" value={form.authority} options={AUTHORITIES} onChange={(value) => set('authority', value as Form['authority'])} />
            <Field label="Form / type" value={form.formType} required placeholder="ASMT-10, DRC-01, 143(2)" onChange={(value) => set('formType', value)} />
            <Field label="Reference / DIN" value={form.referenceNo} onChange={(value) => set('referenceNo', value)} />
            <Field label="Period" value={form.period} placeholder="2026-10 or FY 2025-26" onChange={(value) => set('period', value)} />
            <Field label="Notice date" type="date" value={form.issuedOn} onChange={(value) => set('issuedOn', value)} />
            <Field label="Reply due" type="date" value={form.replyDue} onChange={(value) => set('replyDue', value)} />
            <Field label="Amount demanded (₹)" value={form.amountInr} onChange={(value) => set('amountInr', value)} />
            <SelectField label="Status" value={form.status} options={[['open', 'Open'], ['replied', 'Replied'], ['closed', 'Closed']]} onChange={(value) => set('status', value as Form['status'])} />
            <div className="md:col-span-4">
              <Field label="Invoices it is about" value={form.invoiceNumbers} placeholder="EXP/2026-27/0012, EXP/2026-27/0015" onChange={(value) => set('invoiceNumbers', value)} />
            </div>
            <div className="md:col-span-4">
              <TextAreaField label="What the notice says" value={form.summary} rows={3} onChange={(value) => set('summary', value)} />
            </div>
            <div className="md:col-span-4">
              <TextAreaField label="Reply" value={form.reply} rows={10} onChange={(value) => set('reply', value)} />
            </div>
            {note && (
              <div className="md:col-span-4">
                <Notice>{note}</Notice>
              </div>
            )}
            <div className="md:col-span-4 flex flex-wrap gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save notice'}
              </button>
              <button type="button" disabled={busy} onClick={draft} className={secondaryButton}>
                <Sparkles className="w-3.5 h-3.5" />
                Draft reply from records
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
        ) : data.notices.length === 0 ? (
          <p className="text-sm text-slate-500">No notices logged.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.notices.map((notice) => (
              <li key={notice.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-950">
                    {notice.formType} {notice.referenceNo && <span className="font-normal text-slate-500">· {notice.referenceNo}</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {notice.authorityLabel}
                    {notice.period ? ` · ${notice.period}` : ''}
                    {notice.amountInr !== null ? ` · ${formatInr(notice.amountInr)}` : ''}
                    {notice.invoiceNumbers.length ? ` · ${notice.invoiceNumbers.join(', ')}` : ''}
                  </p>
                  {notice.summary && <p className="mt-1 text-slate-700 line-clamp-2">{notice.summary}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {dueLabel(notice)}
                  <button type="button" onClick={() => { setForm(toForm(notice)); setNote(''); }} className={secondaryButton}>
                    Open
                  </button>
                  {canDelete && (
                    <button type="button" onClick={() => remove(notice)} className={dangerButton}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
};
