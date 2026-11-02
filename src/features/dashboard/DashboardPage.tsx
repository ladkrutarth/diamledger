import React, { useEffect, useState } from 'react';
import { api, errorMessage, type Dashboard, type InvoiceStatus } from '../../api/client';
import { formatCarats, formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, Page } from '../../components/ui';
import { CashFlowCard } from './CashFlowCard';

interface Props {
  onOpen: (id: string) => void;
  onFollowUp: () => void;
  onBrowse: (status: InvoiceStatus) => void;
}

const AGING_COLOR: Record<string, string> = {
  current: 'bg-sky-500',
  '1-30': 'bg-amber-400',
  '31-60': 'bg-orange-500',
  '61-90': 'bg-orange-700',
  '90+': 'bg-red-700',
};

const Stat: React.FC<{ label: string; value: string; hint?: string; tone?: 'default' | 'alert'; onClick?: () => void }> = ({
  label,
  value,
  hint,
  tone = 'default',
  onClick,
}) => {
  const className = `w-full rounded-xl border bg-white p-4 text-left ${
    tone === 'alert' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'
  } ${onClick ? 'hover:border-slate-400' : ''}`;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
    </Tag>
  );
};

export const DashboardPage: React.FC<Props> = ({ onOpen, onFollowUp, onBrowse }) => {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Dashboard>('/api/dashboard')
      .then(setData)
      .catch((err) => setError(errorMessage(err, 'Could not load the dashboard.')));
  }, []);

  const month = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const maxMonth = Math.max(1, ...(data?.months.map((row) => row.totalUsd) ?? []));
  const maxCountry = Math.max(1, ...(data?.byCountry.map((row) => row.totalUsd) ?? []));
  const maxBuyer = Math.max(1, ...(data?.topBuyers.map((row) => row.dueUsd) ?? []));
  const agingTotal = data?.aging.reduce((sum, bucket) => sum + bucket.dueUsd, 0) ?? 0;
  const overdueUsd = data?.aging.filter((bucket) => bucket.key !== 'current').reduce((sum, bucket) => sum + bucket.dueUsd, 0) ?? 0;
  const overdueCount = data?.aging.filter((bucket) => bucket.key !== 'current').reduce((sum, bucket) => sum + bucket.count, 0) ?? 0;
  const stages: Array<[InvoiceStatus, string, string]> = data
    ? [
        ['draft', 'Draft', 'Still being prepared'],
        ['issued', 'Issued', 'Sent, waiting for payment'],
        ['paid', 'Paid', 'Collected in full'],
        ['cancelled', 'Cancelled', 'Closed and locked'],
      ]
    : [];

  return (
    <Page
      title="Dashboard"
      description="Shipments, what has been collected, and which balances need a reminder. Click a status to open that list."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="text-sm text-slate-500">Loading...</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stages.map(([status, label, hint]) => (
              <button
                key={status}
                type="button"
                onClick={() => onBrowse(status)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-400"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{data.statusCounts[status] ?? 0}</p>
                <p className="mt-1 text-xs text-slate-500">{hint}</p>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <Stat
              label={`Issued in ${month}`}
              value={formatUsd(data.thisMonth.totalUsd)}
              hint={`${data.thisMonth.count} invoices · ${formatCarats(data.thisMonth.totalCarats)}`}
              onClick={() => onBrowse('issued')}
            />
            <Stat
              label={`Collected in ${month}`}
              value={formatUsd(data.collectedThisMonth.totalUsd)}
              hint={data.collectedThisMonth.count === 0 ? 'No payments recorded this month' : `${data.collectedThisMonth.count} payments received`}
            />
            <Stat
              label="Still to collect"
              value={formatUsd(data.unpaid.dueUsd)}
              hint={`${data.unpaid.count} invoices with a balance`}
              onClick={() => onBrowse('issued')}
            />
            <Stat
              label="Overdue"
              value={formatUsd(overdueUsd)}
              hint={overdueCount === 0 ? 'Nothing is past its due date' : `${overdueCount} invoices past the credit days`}
              tone={overdueCount > 0 ? 'alert' : 'default'}
              onClick={onFollowUp}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <Card title="Issued value, last 6 months" className="lg:col-span-3">
              <div className="flex items-end gap-3 h-40">
                {data.months.map((row) => (
                  <div key={row.month} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                    <p className="mb-1 text-[10px] tabular-nums text-slate-500">{row.count}</p>
                    <div
                      className="w-full rounded-t bg-slate-900"
                      style={{ height: `${Math.max(4, (row.totalUsd / maxMonth) * 100)}%` }}
                      title={`${row.label}: ${formatUsd(row.totalUsd)}`}
                    />
                    <p className="mt-1 text-[11px] font-medium text-slate-600">{row.label}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="How old the balances are" className="lg:col-span-2">
              <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
                {data.aging.map((bucket) =>
                  bucket.dueUsd > 0 ? (
                    <div
                      key={bucket.key}
                      className={AGING_COLOR[bucket.key]}
                      style={{ width: `${(bucket.dueUsd / Math.max(agingTotal, 1)) * 100}%` }}
                      title={`${bucket.label}: ${formatUsd(bucket.dueUsd)}`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="mt-3 space-y-1.5">
                {data.aging.map((bucket) => (
                  <li key={bucket.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 text-slate-700">
                      <span className={`h-2 w-2 rounded-full ${AGING_COLOR[bucket.key]}`} />
                      {bucket.label}
                    </span>
                    <span className="tabular-nums text-slate-800">
                      {formatUsd(bucket.dueUsd)}
                      <span className="text-slate-400"> · {bucket.count}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {overdueCount > 0 && (
                <button type="button" onClick={onFollowUp} className="mt-3 text-xs font-semibold text-amber-900 underline">
                  Open collections
                </button>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Who owes the most">
              {data.topBuyers.length === 0 ? (
                <p className="text-sm text-slate-500">No open balances.</p>
              ) : (
                <ul className="space-y-3">
                  {data.topBuyers.map((row) => (
                    <li key={row.buyer}>
                      <div className="flex justify-between gap-3 text-sm">
                        <span className="truncate font-medium text-slate-800">{row.buyer}</span>
                        <span className="shrink-0 tabular-nums">{formatUsd(row.dueUsd)}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                        <div className="h-1.5 rounded-full bg-slate-800" style={{ width: `${(row.dueUsd / maxBuyer) * 100}%` }} />
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {row.invoices} open · {formatUsd(row.overdueUsd)} overdue
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Longest overdue">
              {data.unpaid.invoices.filter((row) => row.overdue).length === 0 ? (
                <p className="text-sm text-slate-500">No invoice is past its due date.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.unpaid.invoices.filter((row) => row.overdue).map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <button type="button" onClick={() => onOpen(row.id)} className="whitespace-nowrap font-mono text-xs font-semibold text-slate-950 hover:underline">
                          {row.invoiceNumber}
                        </button>
                        <p className="truncate text-xs text-slate-500">
                          {row.buyerName || 'No buyer'} · {row.daysOverdue} days overdue
                        </p>
                      </div>
                      <p className="shrink-0 font-semibold tabular-nums">{formatUsd(row.dueUsd)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" onClick={onFollowUp} className="mt-2 text-xs font-semibold text-slate-700 underline">
                All collections
              </button>
            </Card>

            <Card title="Exports by destination">
              {data.byCountry.length === 0 ? (
                <p className="text-sm text-slate-500">Issue an invoice to see destinations here.</p>
              ) : (
                <ul className="space-y-2.5">
                  {data.byCountry.map((row) => (
                    <li key={row.country}>
                      <div className="flex justify-between gap-3 text-sm">
                        <span className="font-medium text-slate-800">{row.country}</span>
                        <span className="tabular-nums text-slate-700">
                          {formatUsd(row.totalUsd)} · {row.count}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                        <div className="h-1.5 rounded-full bg-sky-600" style={{ width: `${(row.totalUsd / maxCountry) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <CashFlowCard onOpen={onOpen} />
        </>
      )}
    </Page>
  );
};
