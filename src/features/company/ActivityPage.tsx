import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, type AuditEvent } from '../../api/client';
import { TableHead, cell } from '../../components/shared';
import { Card, Notice, Page, inputClass, secondaryButton } from '../../components/ui';

function query(from: string, to: string, search: string): string {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (search.trim()) params.set('q', search.trim());
  return params.toString();
}

export const ActivityPage: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setEvents(null);
    api<{ events: AuditEvent[] }>(`/api/audit?${applied}`)
      .then((result) => {
        if (!current) return;
        setEvents(result.events);
        setError('');
      })
      .catch((err) => current && setError(errorMessage(err, 'Could not load the activity history.')));
    return () => {
      current = false;
    };
  }, [applied]);

  return (
    <Page
      title="Activity"
      description="Who created, issued, paid, cancelled, matched, or closed what, and when. Changes confirmed through the assistant are listed too. Entries cannot be edited or deleted."
      actions={
        <a href={`/api/audit/csv?${applied}`} className={secondaryButton}>
          <Download className="w-3.5 h-3.5" />
          CSV
        </a>
      }
    >
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(query(from, to, search));
          }}
        >
          <label className="text-xs font-semibold text-slate-600">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <label className="text-xs font-semibold text-slate-600 flex-1 min-w-48">
            Search
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Invoice number, person, or action"
              className={`${inputClass} mt-1`}
            />
          </label>
          <button type="submit" className={secondaryButton}>
            Filter
          </button>
        </form>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {events === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-500">No activity recorded for this filter yet. New changes appear here as they happen.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['When', 'Who', 'What']} />
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className={`${cell} whitespace-nowrap tabular-nums text-slate-600`}>{new Date(event.at).toLocaleString()}</td>
                    <td className={cell}>{event.userEmail}</td>
                    <td className={cell}>
                      {event.entityType === 'invoice' && event.entityId ? (
                        <button type="button" onClick={() => onOpen(event.entityId)} className="text-left hover:underline">
                          {event.summary}
                        </button>
                      ) : (
                        event.summary
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {events.length >= 200 && <p className="mt-2 text-xs text-slate-500">Showing the latest 200. Use the dates or the CSV for more.</p>}
          </div>
        )}
      </Card>
    </Page>
  );
};
