import React, { useEffect, useState } from 'react';
import { api, errorMessage, type Dashboard } from '../../api/client';
import { formatCarats, formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, Page } from '../ui';

interface Props {
  onOpen: (id: string) => void;
}

const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <Card>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-1 text-2xl font-bold text-slate-950 tabular-nums">{value}</p>
    {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
  </Card>
);

export const DashboardPage: React.FC<Props> = ({ onOpen }) => {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Dashboard>('/api/dashboard')
      .then(setData)
      .catch((err) => setError(errorMessage(err, 'Could not load the dashboard.')));
  }, []);

  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const maxCountry = Math.max(1, ...(data?.byCountry.map((row) => row.totalUsd) ?? []));

  return (
    <Page title="Dashboard" description="Issued and paid invoices. Drafts and cancelled invoices are not counted.">
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="text-sm text-slate-500">Loading...</p>}
      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Stat label={`Exports in ${month}`} value={formatUsd(data.thisMonth.totalUsd)} hint={`${data.thisMonth.count} invoices`} />
            <Stat label={`Carats in ${month}`} value={formatCarats(data.thisMonth.totalCarats)} />
            <Stat label="Unpaid balance" value={formatUsd(data.unpaid.dueUsd)} hint={`${data.unpaid.count} invoices awaiting payment`} />
            <Stat
              label="Drafts"
              value={String(data.statusCounts.draft ?? 0)}
              hint={`${data.statusCounts.paid ?? 0} paid · ${data.statusCounts.cancelled ?? 0} cancelled`}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Exports by destination">
              {data.byCountry.length === 0 ? (
                <p className="text-sm text-slate-500">Issue an invoice to see destinations here.</p>
              ) : (
                <ul className="space-y-2.5">
                  {data.byCountry.map((row) => (
                    <li key={row.country}>
                      <div className="flex justify-between text-sm">
                        <span className="font-medium text-slate-800">{row.country}</span>
                        <span className="tabular-nums text-slate-700">
                          {formatUsd(row.totalUsd)} · {row.count}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-sky-500"
                          style={{ width: `${(row.totalUsd / maxCountry) * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Waiting for payment">
              {data.unpaid.invoices.length === 0 ? (
                <p className="text-sm text-slate-500">Every issued invoice has been paid.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.unpaid.invoices.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div>
                        <button
                          type="button"
                          onClick={() => onOpen(row.id)}
                          className="font-mono font-semibold text-slate-950 hover:underline"
                        >
                          {row.invoiceNumber}
                        </button>
                        <p className="text-xs text-slate-500">
                          {row.buyerName || 'No buyer'} · {row.invoiceDate ?? 'no date'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold tabular-nums">{formatUsd(row.dueUsd)}</p>
                        <p className="text-xs text-slate-500 tabular-nums">of {formatUsd(row.totalUsd)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </Page>
  );
};
