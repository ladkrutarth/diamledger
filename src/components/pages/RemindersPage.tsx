import React, { useEffect, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import {
  ApiError,
  api,
  errorMessage,
  sendJson,
  type OverdueInvoice,
  type ReminderDraft,
  type ReminderSent,
} from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { DEFAULT_SMTP, SmtpFields, smtpPayload, type SmtpConfig } from '../SmtpFields';
import { Card, Notice, Page, dangerButton, inputClass, primaryButton, secondaryButton } from '../ui';

type Editing = {
  draft: ReminderDraft;
  subject: string;
  greeting: string;
  body: string;
  recipients: string;
  cc: string;
};

const TONE_LABELS: Record<ReminderDraft['tone'], string> = {
  gentle: 'Gentle first reminder',
  firm: 'Firm follow-up',
  final: 'Final reminder',
};

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export const RemindersPage: React.FC<{ readOnly?: boolean }> = ({ readOnly = false }) => {
  const [invoices, setInvoices] = useState<OverdueInvoice[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [smtp, setSmtp] = useState<SmtpConfig>(DEFAULT_SMTP);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api<{ invoices: OverdueInvoice[] }>('/api/reminders/overdue')
      .then((result) => setInvoices(result.invoices))
      .catch((err) => setError(errorMessage(err, 'Could not load overdue invoices.')));

  useEffect(() => {
    load();
  }, []);

  const draft = async (invoice: OverdueInvoice, confirmRepeat = false) => {
    setBusy(invoice.id);
    setError('');
    setNotice('');
    try {
      const result = await api<ReminderDraft>('/api/reminders/draft', sendJson('POST', { invoiceId: invoice.id, confirmRepeat }));
      setEditing({
        draft: result,
        subject: result.subject,
        greeting: result.greeting,
        body: result.paragraphs.join('\n\n'),
        recipients: result.recipients.join(', '),
        cc: '',
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.recentlyReminded && !confirmRepeat) {
        if (window.confirm(`${err.message}\n\nDraft another reminder for ${invoice.invoiceNumber}?`)) {
          await draft(invoice, true);
        }
        return;
      }
      setError(errorMessage(err, 'Could not draft the reminder.'));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!editing) return;
    setBusy(editing.draft.id);
    setError('');
    try {
      const result = await api<ReminderSent>(
        `/api/reminders/${editing.draft.id}/send`,
        sendJson('POST', {
          subject: editing.subject,
          greeting: editing.greeting,
          paragraphs: editing.body.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean),
          recipients: splitList(editing.recipients),
          cc: splitList(editing.cc),
          smtpConfig: smtpPayload(smtp, editing.draft.figures.exporterName),
        }),
      );
      setNotice(
        result.mode === 'live_smtp'
          ? `Reminder for ${editing.draft.figures.invoiceNumber} sent.`
          : `Reminder for ${editing.draft.figures.invoiceNumber} recorded, but not emailed: enter an SMTP password to send real email.`,
      );
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not send the reminder.'));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (!editing) return;
    setBusy(editing.draft.id);
    setError('');
    try {
      await api(`/api/reminders/${editing.draft.id}/discard`, sendJson('POST'));
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not discard the draft.'));
    } finally {
      setBusy(null);
    }
  };

  const update = (patch: Partial<Editing>) => setEditing((current) => (current ? { ...current, ...patch } : current));

  return (
    <Page
      title="Collections"
      description="Invoices that are past the agreed credit days and still have a balance. Draft a reminder, read it, then send it."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      {editing && (
        <Card title={`Reminder for ${editing.draft.figures.invoiceNumber}`}>
          <div className="space-y-4 text-sm">
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{TONE_LABELS[editing.draft.tone]}</span>
              {' · '}
              {editing.draft.source === 'model' ? 'Wording drafted by Gemini' : 'Standard wording (AI draft unavailable)'}
              {' · '}Check the wording before you send. Amounts, dates, and bank details are filled in from the invoice.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-600 mb-1">To</span>
                <input value={editing.recipients} onChange={(e) => update({ recipients: e.target.value })} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-slate-600 mb-1">CC</span>
                <input value={editing.cc} onChange={(e) => update({ cc: e.target.value })} className={inputClass} />
              </label>
            </div>
            <label className="block">
              <span className="block text-[11px] font-semibold text-slate-600 mb-1">Subject</span>
              <div className="flex items-center gap-2">
                <input value={editing.subject} onChange={(e) => update({ subject: e.target.value })} className={inputClass} />
                <span className="text-xs text-slate-500 whitespace-nowrap">- Invoice {editing.draft.figures.invoiceNumber}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-slate-600 mb-1">Greeting</span>
              <input value={editing.greeting} onChange={(e) => update({ greeting: e.target.value })} className={inputClass} />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-slate-600 mb-1">Message (blank line between paragraphs)</span>
              <textarea
                value={editing.body}
                onChange={(e) => update({ body: e.target.value })}
                rows={7}
                className={inputClass}
              />
            </label>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <p className="font-semibold text-slate-700 mb-1.5">Added below the message from the invoice</p>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                <dt className="text-slate-500">Due date</dt>
                <dd className="font-semibold tabular-nums">{editing.draft.figures.dueDate}</dd>
                <dt className="text-slate-500">Balance due</dt>
                <dd className="font-semibold tabular-nums">{formatUsd(editing.draft.figures.dueUsd)}</dd>
                <dt className="text-slate-500">Invoice total</dt>
                <dd className="tabular-nums">{formatUsd(editing.draft.figures.totalUsd)}</dd>
                <dt className="text-slate-500">Bank</dt>
                <dd>{editing.draft.figures.bank.bankName || 'Not set'}</dd>
              </dl>
            </div>

            <SmtpFields value={smtp} onChange={setSmtp} />

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={discard} disabled={busy !== null} className={dangerButton}>
                Discard draft
              </button>
              <button type="button" onClick={() => setEditing(null)} disabled={busy !== null} className={secondaryButton}>
                Close
              </button>
              <button type="button" onClick={send} disabled={busy !== null} className={primaryButton}>
                <Send className="w-3.5 h-3.5" />
                {busy === editing.draft.id ? 'Sending...' : 'Send reminder'}
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Overdue invoices">
        {!invoices && !error && <p className="text-sm text-slate-500">Loading...</p>}
        {invoices && invoices.length === 0 && (
          <p className="text-sm text-slate-500">No invoice is past its credit days with a balance due.</p>
        )}
        {invoices && invoices.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {invoices.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-mono font-semibold text-slate-950">{row.invoiceNumber}</p>
                  <p className="text-xs text-slate-500">
                    {row.buyerName || 'No buyer'} · due {row.dueDate} · {row.daysOverdue} days overdue
                    {row.remindersSent > 0 && ` · ${row.remindersSent} reminder${row.remindersSent === 1 ? '' : 's'} sent`}
                    {!row.buyerEmail && ' · no buyer email on the invoice'}
                  </p>
                  {row.recentlyReminded && row.lastReminderAt && (
                    <p className="text-xs text-amber-700">Reminded on {row.lastReminderAt.slice(0, 10)}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{formatUsd(row.dueUsd)}</p>
                    <p className="text-xs text-slate-500 tabular-nums">of {formatUsd(row.totalUsd)}</p>
                  </div>
                  {!readOnly && (
                    <button type="button" onClick={() => draft(row)} disabled={busy !== null} className={secondaryButton}>
                      <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                      {busy === row.id ? 'Drafting...' : 'Draft reminder'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
};
