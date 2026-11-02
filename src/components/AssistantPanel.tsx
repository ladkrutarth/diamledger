import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, ClipboardCheck, Loader2, MessageSquarePlus, Send, X } from 'lucide-react';
import {
  api,
  ApiError,
  errorMessage,
  sendJson,
  type AssistantAction,
  type AssistantActionKind,
  type AssistantSession,
  type AssistantSource,
  type AssistantTurn,
  type MonthReview,
  type MonthReviewFindings,
  type Role,
} from '../api/client';
import { formatUsd } from '../utils/invoiceDefaults';

type Props = {
  userId: string;
  role: Role;
  onClose: () => void;
  onChanged: () => void;
  onOpenInvoice: (id: string) => void;
};

type Entry =
  | { type: 'message'; key: string; role: 'user' | 'model'; text: string; sources?: AssistantSource[]; ungrounded?: boolean }
  | { type: 'action'; key: string; action: AssistantAction }
  | { type: 'review'; key: string; findings: MonthReviewFindings };

const INVOICE_SUGGESTIONS = [
  'Which invoices are overdue?',
  'How much is still unpaid in total?',
  'What does Antwerp owe us?',
];

const TAX_SUGGESTIONS = [
  'What tax deadlines are coming up?',
  'Is last month ready for GSTR-1?',
  'Which invoices are near the FEMA realization deadline?',
  'Which bank credits are still unmatched?',
];

function canUseTaxDesk(role: Role): boolean {
  return role === 'admin' || role === 'tax' || role === 'ca';
}

function lastMonth(): string {
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
}

function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Math.abs(value || 0));
}

function storageKey(userId: string) {
  return `assistant-session:${userId}`;
}

function entriesFrom(session: AssistantSession): Entry[] {
  const timeline: Array<{ at: string; entry: Entry }> = [
    ...session.messages.map((message) => ({
      at: message.createdAt,
      entry: { type: 'message' as const, key: message.id, role: message.role, text: message.text },
    })),
    ...session.actions.map((action) => ({
      at: action.createdAt,
      entry: { type: 'action' as const, key: action.id, action },
    })),
  ];
  return timeline.sort((a, b) => a.at.localeCompare(b.at)).map((item) => item.entry);
}

function Sources({ sources, onOpenInvoice }: { sources: AssistantSource[]; onOpenInvoice: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="mt-1.5 text-[11px]">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-0.5 font-semibold text-slate-500 hover:text-slate-800"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Sources ({sources.length})
      </button>
      {open && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {sources.map((source) => (
            <li key={`${source.kind}:${source.id ?? source.label}`}>
              {source.kind === 'invoice' && source.id ? (
                <button
                  onClick={() => onOpenInvoice(source.id!)}
                  className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-sky-700 hover:border-sky-300"
                >
                  {source.label}
                </button>
              ) : (
                <span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600">{source.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function actionSummary(action: AssistantAction): string {
  const { payload } = action;
  if (action.kind === 'record_payment') {
    return `Record ${formatUsd(payload.amountUsd ?? 0)} received on ${payload.paidOn} against ${payload.invoiceNumber}${
      payload.reference ? ` (ref ${payload.reference})` : ''
    }.`;
  }
  if (action.kind === 'match_bank_line') {
    return `Match the bank credit of ${formatUsd(payload.amountUsd ?? 0)} on ${payload.lineDate} to ${payload.invoiceNumber} (${
      payload.buyer
    }). This records the payment and marks the bank line matched.`;
  }
  if (action.kind === 'close_month') {
    return `Close the books for ${payload.month}. Invoices and payments dated in that month stay locked until a chartered accountant reopens it.`;
  }
  return `Draft a payment reminder for ${payload.invoiceNumber} (${formatUsd(payload.dueUsd ?? 0)} due, ${
    payload.daysOverdue
  } days overdue). It is saved as a draft on Follow-ups; nothing is emailed.`;
}

const ACTION_TITLE: Record<AssistantActionKind, string> = {
  record_payment: 'Proposed payment',
  draft_reminder: 'Proposed reminder',
  match_bank_line: 'Proposed bank match',
  close_month: 'Proposed month close',
};

const ACTION_DONE: Record<AssistantActionKind, string> = {
  record_payment: 'Payment recorded',
  draft_reminder: 'Draft created on Follow-ups',
  match_bank_line: 'Payment recorded and line matched',
  close_month: 'Month closed',
};

const CLOSE_TONE: Record<MonthReviewFindings['close']['status'], string> = {
  ready: 'text-emerald-800',
  closed: 'text-slate-600',
  not_ended: 'text-slate-600',
  blocked: 'text-amber-800',
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-white border border-slate-200 px-2 py-1.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

function ReviewCard({ findings }: { findings: MonthReviewFindings }) {
  const { filing, register, realization, forex, bank, close } = findings;
  return (
    <section aria-label={`Review of ${findings.month}`} className="rounded-lg border border-slate-200 bg-slate-100/70 p-2.5 text-xs">
      <p className="font-bold text-slate-900">Month review: {findings.month}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1.5">
        <Fact label="GSTR-1 ready">
          {filing.readyCount} of {filing.invoiceCount}
          {filing.issueCount > 0 && <span className="text-amber-800"> · {filing.issueCount} to fix</span>}
        </Fact>
        <Fact label="Export register">
          {register.count} · {formatUsd(register.taxableUsd)}
        </Fact>
        <Fact label="Awaiting realization">
          {realization.openCount} · {formatUsd(realization.openUsd)}
          {realization.overdueCount > 0 && <span className="text-red-700"> · {realization.overdueCount} overdue</span>}
        </Fact>
        <Fact label="Forex net">
          {forex.paymentCount === 0
            ? 'No receipts'
            : `${forex.netInr < 0 ? 'Loss' : 'Gain'} ${formatInr(forex.netInr)}`}
          {forex.missingRateCount > 0 && <span className="text-amber-800"> · {forex.missingRateCount} no rate</span>}
        </Fact>
        <Fact label="Bank credits">
          {bank.unmatchedCount} unmatched · {bank.strongMatchCount} strong
        </Fact>
        <Fact label="Books">
          <span className={CLOSE_TONE[close.status]}>
            {close.status === 'ready' ? 'Ready to close' : close.status === 'closed' ? 'Closed' : close.status === 'not_ended' ? 'Month not over' : 'Not ready'}
          </span>
        </Fact>
      </dl>
      {filing.companyIssues.map((issue) => (
        <p key={issue} className="mt-1.5 text-amber-800">{issue}</p>
      ))}
      {filing.invoicesWithIssues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-slate-700">
          {filing.invoicesWithIssues.map((row) => (
            <li key={row.invoiceNumber}>
              <span className="font-semibold">{row.invoiceNumber}</span>: {row.issues[0]}
              {row.issues.length > 1 && ` (+${row.issues.length - 1} more)`}
            </li>
          ))}
        </ul>
      )}
      <p className={`mt-1.5 ${CLOSE_TONE[close.status]}`}>{close.detail}</p>
    </section>
  );
}

function ActionCard({
  action,
  onDecided,
}: {
  action: AssistantAction;
  onDecided: (action: AssistantAction) => void;
}) {
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'confirm' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      const result = await api<{ action: AssistantAction }>(`/api/assistant/actions/${action.id}/${decision}`, sendJson('POST'));
      onDecided(result.action);
    } catch (err) {
      const failed = err instanceof ApiError ? (err.body?.action as AssistantAction | undefined) : undefined;
      if (failed) onDecided(failed);
      setError(errorMessage(err, 'Could not save your decision.'));
    } finally {
      setBusy(null);
    }
  };

  const title = ACTION_TITLE[action.kind];
  const statusText: Record<AssistantAction['status'], string> = {
    proposed: 'Waiting for you',
    confirmed: ACTION_DONE[action.kind],
    rejected: 'Rejected',
    failed: 'Not done',
  };

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-indigo-900">{title}</span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            action.status === 'confirmed' ? 'text-emerald-700' : action.status === 'proposed' ? 'text-indigo-700' : 'text-slate-500'
          }`}
        >
          {statusText[action.status]}
        </span>
      </div>
      <p className="mt-1 text-slate-700">{actionSummary(action)}</p>
      {action.kind === 'draft_reminder' && action.payload.remindedInLastWeek && action.status === 'proposed' && (
        <p className="mt-1 text-amber-800">A reminder for this invoice was already sent in the last week.</p>
      )}
      {action.kind === 'match_bank_line' && action.payload.reasons && action.payload.reasons.length > 0 && (
        <p className="mt-1 text-slate-500">
          Match score {action.payload.score}/100: {action.payload.reasons.join('; ')}.
        </p>
      )}
      {action.status === 'failed' && action.result?.error && <p className="mt-1 text-red-700">{action.result.error}</p>}
      {error && action.status === 'proposed' && <p className="mt-1 text-red-700" role="alert">{error}</p>}
      {action.status === 'proposed' && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => decide('confirm')}
            disabled={busy !== null}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-50"
          >
            <Check className="w-3 h-3" />
            {busy === 'confirm' ? 'Saving...' : 'Confirm'}
          </button>
          <button
            onClick={() => decide('reject')}
            disabled={busy !== null}
            className="px-2.5 py-1 rounded-md border border-slate-300 bg-white font-semibold hover:bg-slate-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function AssistantPanel({ userId, role, onClose, onChanged, onOpenInvoice }: Props) {
  const taxDesk = canUseTaxDesk(role);
  const suggestions = taxDesk ? [...TAX_SUGGESTIONS, ...INVOICE_SUGGESTIONS.slice(0, 2)] : INVOICE_SUGGESTIONS;
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(storageKey(userId)));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionFull, setSessionFull] = useState(false);
  const [reviewMonth, setReviewMonth] = useState(lastMonth);
  const [reviewing, setReviewing] = useState(false);
  const loadedLocally = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionId || loadedLocally.current === sessionId) return;
    api<AssistantSession>(`/api/assistant/sessions/${sessionId}`)
      .then((session) => setEntries(entriesFrom(session)))
      .catch(() => {
        localStorage.removeItem(storageKey(userId));
        setSessionId(null);
      });
  }, [sessionId, userId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries, sending, reviewing]);

  const review = async () => {
    if (reviewing || sending || !/^\d{4}-\d{2}$/.test(reviewMonth)) return;
    setReviewing(true);
    setError(null);
    setSessionFull(false);
    try {
      const result = await api<MonthReview>('/api/assistant/reviews', sendJson('POST', { month: reviewMonth }));
      loadedLocally.current = result.sessionId;
      localStorage.setItem(storageKey(userId), result.sessionId);
      setSessionId(result.sessionId);
      setEntries([
        { type: 'message', key: `review-question-${result.sessionId}`, role: 'user', text: `Review the books for ${result.month}.` },
        { type: 'review', key: `review-${result.sessionId}`, findings: result.findings },
        { type: 'message', key: `review-summary-${result.sessionId}`, role: 'model', text: result.summary },
        ...result.actions.map((action) => ({ type: 'action' as const, key: action.id, action })),
      ]);
    } catch (err) {
      setError(errorMessage(err, 'The month review could not run. Try again.'));
    } finally {
      setReviewing(false);
    }
  };

  const startNew = () => {
    localStorage.removeItem(storageKey(userId));
    setSessionId(null);
    setEntries([]);
    setError(null);
    setSessionFull(false);
  };

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const session = await api<AssistantSession>('/api/assistant/sessions', sendJson('POST'));
    localStorage.setItem(storageKey(userId), session.id);
    setSessionId(session.id);
    return session.id;
  };

  const send = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || sending || reviewing) return;
    setSending(true);
    setError(null);
    setText('');
    setEntries((prev) => [...prev, { type: 'message', key: `local-${Date.now()}`, role: 'user', text: trimmed }]);
    try {
      const id = await ensureSession();
      const turn = await api<AssistantTurn>(`/api/assistant/sessions/${id}/messages`, sendJson('POST', { text: trimmed }));
      setEntries((prev) => [
        ...prev,
        {
          type: 'message',
          key: `reply-${Date.now()}`,
          role: 'model',
          text: turn.reply,
          sources: turn.sources,
          ungrounded: turn.ungrounded,
        },
        ...turn.actions.map((action) => ({ type: 'action' as const, key: action.id, action })),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.body?.sessionFull) setSessionFull(true);
      setError(errorMessage(err, 'The assistant could not answer. Try again.'));
    } finally {
      setSending(false);
    }
  };

  const updateAction = (action: AssistantAction) => {
    setEntries((prev) =>
      prev.map((entry) => (entry.type === 'action' && entry.action.id === action.id ? { ...entry, action } : entry)),
    );
    if (action.status === 'confirmed') onChanged();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button aria-label="Close assistant" onClick={onClose} className="flex-1 bg-slate-950/20" />
      <aside
        role="dialog"
        aria-label={taxDesk ? 'Tax and invoice assistant' : 'Invoice assistant'}
        className="w-full max-w-md h-full bg-white border-l border-slate-200 shadow-xl flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-indigo-600" />
            <div className="leading-tight">
              <span className="block text-sm font-bold text-slate-950">{taxDesk ? 'Tax and invoice assistant' : 'Invoice assistant'}</span>
              <span className="block text-[11px] text-slate-500">
                Answers from your {taxDesk ? 'books and tax desk' : 'invoices'}. Changes need your confirmation.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={startNew}
              title="New conversation"
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
            <button onClick={onClose} title="Close" className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {taxDesk && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              review();
            }}
            className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 text-xs"
          >
            <label htmlFor="assistant-review-month" className="font-semibold text-slate-700">
              Month
            </label>
            <input
              id="assistant-review-month"
              type="month"
              value={reviewMonth}
              onChange={(event) => setReviewMonth(event.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:border-indigo-400"
            />
            <button
              type="submit"
              disabled={reviewing || sending || !reviewMonth}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-50"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              {reviewing ? 'Reviewing...' : 'Review month'}
            </button>
          </form>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50">
          {entries.length === 0 && !sending && !reviewing && (
            <div className="text-xs text-slate-600">
              <p className="mb-2">
                {taxDesk
                  ? 'Ask about invoices, payments, tax deadlines, filing, realization, forex, or bank matches. Or review a month above. For example:'
                  : 'Ask about invoices, payments, buyers, or overdue balances. For example:'}
              </p>
              <div className="flex flex-col items-start gap-1.5">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => send(suggestion)}
                    className="px-2.5 py-1 rounded-full border border-slate-300 bg-white hover:border-indigo-300 hover:text-indigo-700"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {entries.map((entry) =>
            entry.type === 'review' ? (
              <ReviewCard key={entry.key} findings={entry.findings} />
            ) : entry.type === 'action' ? (
              <ActionCard key={entry.key} action={entry.action} onDecided={updateAction} />
            ) : (
              <div key={entry.key} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap ${
                    entry.role === 'user' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-800'
                  }`}
                >
                  {entry.text}
                  {entry.ungrounded && (
                    <p className="mt-1.5 flex items-start gap-1 rounded bg-amber-50 border border-amber-200 px-1.5 py-1 text-[11px] text-amber-900">
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                      Some amounts in this answer were not in the data the assistant looked up. Check them before relying on them.
                    </p>
                  )}
                  {entry.sources && <Sources sources={entry.sources} onOpenInvoice={onOpenInvoice} />}
                </div>
              </div>
            ),
          )}
          {(sending || reviewing) && (
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {reviewing ? `Checking filing, realization, forex, and bank lines for ${reviewMonth}...` : 'Looking it up...'}
            </p>
          )}
        </div>

        <div className="border-t border-slate-200 p-3">
          {error && (
            <p role="alert" className="mb-2 text-xs text-red-700">
              {error}
              {sessionFull && (
                <button onClick={startNew} className="ml-1 font-semibold underline">
                  Start a new conversation
                </button>
              )}
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send(text);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send(text);
                }
              }}
              maxLength={2000}
              rows={2}
              placeholder={taxDesk ? 'Ask about invoices or tax...' : 'Ask about your invoices...'}
              className="flex-1 resize-none rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-400"
            />
            <button
              type="submit"
              disabled={sending || !text.trim()}
              className="p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
