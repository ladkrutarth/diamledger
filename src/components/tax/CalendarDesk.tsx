import React, { useEffect, useState } from 'react';
import { api, errorMessage, type CalendarItem } from '../../api/client';
import { Card, Notice } from '../ui';
import { Badge } from './shared';

const STATUS: Record<CalendarItem['status'], { tone: 'red' | 'amber' | 'green' | 'slate'; label: (item: CalendarItem) => string }> = {
  overdue: { tone: 'red', label: (item) => (item.daysLeft === null ? 'Overdue' : `${-item.daysLeft} days late`) },
  due_soon: { tone: 'amber', label: (item) => (item.daysLeft === 0 ? 'Due today' : `${item.daysLeft} days left`) },
  action: { tone: 'amber', label: () => 'To do' },
  upcoming: { tone: 'slate', label: (item) => `In ${item.daysLeft} days` },
  done: { tone: 'green', label: () => 'Books closed' },
};

export const CalendarDesk: React.FC = () => {
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [company, setCompany] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: CalendarItem[]; companies: Array<{ id: string; name: string }> }>('/api/workspace/calendar')
      .then((result) => {
        setItems(result.items);
        setCompanies(result.companies);
      })
      .catch((err) => setError(errorMessage(err, 'Could not load the compliance calendar.')));
  }, []);

  const visible = items?.filter((item) => company === 'all' || item.organizationId === company) ?? [];

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-slate-600 max-w-2xl">
            Due dates across {companies.length > 1 ? `all ${companies.length} companies you look after` : 'this company'}: GSTR-1 on the 11th
            and GSTR-3B on the 20th of the next month, LUT renewal before 1 April, FEMA realization deadlines, and the two-year window for
            refunds on LUT exports.
          </p>
          {companies.length > 1 && (
            <select
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm"
              aria-label="Company"
            >
              <option value="all">All companies</option>
              {companies.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {items === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing due.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((item) => {
              const status = STATUS[item.status];
              return (
                <li key={`${item.organizationId}-${item.kind}-${item.title}`} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-950">{item.title}</p>
                    <p className="text-xs text-slate-600">{item.detail}</p>
                    {companies.length > 1 && <p className="mt-0.5 text-xs text-slate-500">{item.organizationName}</p>}
                  </div>
                  <div className="text-right">
                    <Badge tone={status.tone}>{status.label(item)}</Badge>
                    {item.dueDate && <p className="mt-1 text-xs text-slate-500">{item.dueDate}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
};
