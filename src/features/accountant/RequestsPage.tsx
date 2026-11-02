import React, { useEffect, useState } from 'react';
import { Paperclip, Plus } from 'lucide-react';
import { api, errorMessage, readFileBase64, sendJson, type ClientRequest, type ClientRequestMessage } from '../../api/client';
import { Badge, TextAreaField, useReport } from '../../components/shared';
import { Card, Field, Notice, Page, primaryButton, secondaryButton } from '../../components/ui';

const STATUS: Record<ClientRequest['status'], { tone: 'amber' | 'green' | 'slate'; label: string }> = {
  open: { tone: 'amber', label: 'Waiting for reply' },
  answered: { tone: 'green', label: 'Answered' },
  closed: { tone: 'slate', label: 'Closed' },
};

const MAX_FILE_BYTES = 2_000_000;

const Thread: React.FC<{ request: ClientRequest; onChanged: () => void }> = ({ request, onChanged }) => {
  const [messages, setMessages] = useState<ClientRequestMessage[] | null>(null);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ messages: ClientRequestMessage[] }>(`/api/requests/${request.id}/messages`)
      .then((result) => setMessages(result.messages))
      .catch((err) => setError(errorMessage(err, 'Could not load the replies.')));

  useEffect(() => {
    load();
  }, [request.id]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (file && file.size > MAX_FILE_BYTES) {
      setError('Attachments can be at most 2 MB.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const attachment = file ? { name: file.name, type: file.type, base64: await readFileBase64(file) } : undefined;
      await api(`/api/requests/${request.id}/messages`, sendJson('POST', { body, file: attachment }));
      setBody('');
      setFile(null);
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not send the reply.'));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: 'open' | 'closed') => {
    try {
      await api(`/api/requests/${request.id}/status`, sendJson('POST', { status }));
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not change the request.'));
    }
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 space-y-3">
      {request.detail && <p className="text-sm text-slate-700 whitespace-pre-wrap">{request.detail}</p>}
      {messages === null ? (
        <p className="text-sm text-slate-500">Loading...</p>
      ) : (
        <ul className="space-y-2">
          {messages.map((message) => (
            <li key={message.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <p className="text-xs text-slate-500">
                {message.userEmail} · {message.createdAt.slice(0, 16).replace('T', ' ')}
              </p>
              {message.body && <p className="whitespace-pre-wrap text-slate-800">{message.body}</p>}
              {message.file && (
                <a href={`/api/requests/${request.id}/messages/${message.id}/file`} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-900 underline">
                  <Paperclip className="w-3 h-3" />
                  {message.file.name}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {request.status === 'closed' ? (
        <button type="button" onClick={() => setStatus('open')} className={secondaryButton}>
          Reopen
        </button>
      ) : (
        <form onSubmit={send} className="space-y-2">
          <TextAreaField label="Reply" value={body} rows={3} onChange={setBody} />
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${secondaryButton} cursor-pointer`}>
              <Paperclip className="w-3.5 h-3.5" />
              {file ? file.name : 'Attach a file'}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.csv,.xls,.xlsx" className="hidden" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={busy || (!body.trim() && !file)} className={primaryButton}>
              {busy ? 'Sending...' : 'Send'}
            </button>
            <button type="button" onClick={() => setStatus('closed')} className={secondaryButton}>
              Mark done
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export const RequestsPage: React.FC = () => {
  const [show, setShow] = useState<'active' | 'closed'>('active');
  const { data, error, setError, reload } = useReport<{ requests: ClientRequest[] }>(`/api/requests?status=${show}`, 'Could not load requests.');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ title: string; detail: string; dueDate: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<{ id: string }>('/api/requests', sendJson('POST', form));
      setForm(null);
      setOpenId(created.id);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Requests"
      description="Questions and document requests between your accountant and the company, with replies and files in one place instead of email and WhatsApp."
      actions={
        <button type="button" onClick={() => setForm({ title: '', detail: '', dueDate: '' })} className={primaryButton}>
          <Plus className="w-3.5 h-3.5" />
          New request
        </button>
      }
    >
      <div className="flex gap-1">
        {(['active', 'closed'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setShow(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${show === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'}`}
          >
            {key === 'active' ? 'Open' : 'Done'}
          </button>
        ))}
      </div>

      {form && (
        <Card title="New request">
          <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="md:col-span-3">
              <Field label="What is needed" value={form.title} required placeholder="Bank statement for October, all accounts" onChange={(value) => setForm({ ...form, title: value })} />
            </div>
            <Field label="Needed by" type="date" value={form.dueDate} onChange={(value) => setForm({ ...form, dueDate: value })} />
            <div className="md:col-span-4">
              <TextAreaField label="Details" value={form.detail} rows={3} onChange={(value) => setForm({ ...form, detail: value })} />
            </div>
            <div className="md:col-span-4 flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Send request'}
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
        ) : data.requests.length === 0 ? (
          <p className="text-sm text-slate-500">{show === 'active' ? 'Nothing waiting.' : 'No finished requests yet.'}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.requests.map((request) => (
              <li key={request.id} className="py-3">
                <button type="button" onClick={() => setOpenId(openId === request.id ? null : request.id)} className="w-full text-left">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-950 text-sm">{request.title}</p>
                      <p className="text-xs text-slate-500">
                        {request.createdByEmail} · {request.createdAt.slice(0, 10)}
                        {request.invoiceNumber ? ` · ${request.invoiceNumber}` : ''}
                        {request.messages ? ` · ${request.messages} repl${request.messages === 1 ? 'y' : 'ies'}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {request.dueDate && <Badge tone={request.overdue ? 'red' : 'slate'}>{request.overdue ? `Overdue ${request.dueDate}` : `By ${request.dueDate}`}</Badge>}
                      <Badge tone={STATUS[request.status].tone}>{STATUS[request.status].label}</Badge>
                    </div>
                  </div>
                </button>
                {openId === request.id && <Thread request={request} onChanged={reload} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
};
