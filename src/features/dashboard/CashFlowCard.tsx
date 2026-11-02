import React, { useEffect, useState } from 'react';
import { api, errorMessage, type CashFlowForecast, type ForecastBucket } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice } from '../../components/ui';

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Expected receipts by week, from due dates and each buyer's past payment delay. */
export const CashFlowCard: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [forecast, setForecast] = useState<CashFlowForecast | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<{ label: string; bucket: ForecastBucket } | null>(null);

  useEffect(() => {
    api<CashFlowForecast>('/api/dashboard/forecast')
      .then(setForecast)
      .catch((err) => setError(errorMessage(err, 'Could not load the cash-flow forecast.')));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!forecast) return null;

  const columns: Array<{ key: string; label: string; bucket: ForecastBucket; tone: string }> = [
    { key: 'overdue', label: 'Late', bucket: forecast.overdue, tone: 'bg-red-700' },
    ...forecast.weeks.map((week) => ({ key: week.start, label: shortDate(week.start), bucket: week, tone: 'bg-slate-900' })),
    { key: 'later', label: 'Later', bucket: forecast.later, tone: 'bg-slate-400' },
  ];
  const max = Math.max(1, ...columns.map((column) => column.bucket.expectedUsd));

  return (
    <Card title="Expected receipts by week">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm mb-3">
        <p>
          <span className="text-slate-500">Next 4 weeks </span>
          <span className="font-semibold tabular-nums">{formatUsd(forecast.totals.next4WeeksUsd)}</span>
        </p>
        <p>
          <span className="text-slate-500">All open balances </span>
          <span className="font-semibold tabular-nums">{formatUsd(forecast.totals.openUsd)}</span>
        </p>
      </div>
      <div className="flex items-end gap-1.5 h-36">
        {columns.map((column) => (
          <button
            key={column.key}
            type="button"
            onClick={() => setChosen({ label: column.key === 'overdue' || column.key === 'later' ? column.label : `Week of ${column.label}`, bucket: column.bucket })}
            className="flex-1 flex flex-col items-center justify-end h-full min-w-0 group"
            title={`${column.label}: ${formatUsd(column.bucket.expectedUsd)} from ${column.bucket.invoices.length} invoice(s)`}
          >
            <div
              className={`w-full rounded-t ${column.tone} group-hover:opacity-80`}
              style={{ height: column.bucket.expectedUsd > 0 ? `${Math.max(4, (column.bucket.expectedUsd / max) * 100)}%` : '2px' }}
            />
            <p className="mt-1 text-[10px] font-medium text-slate-600 truncate w-full text-center">{column.label}</p>
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Each open invoice is placed on its due date plus the buyer's average delay on invoices they have already paid. "Late" is money
        that should already have arrived. Click a bar to see the invoices.
      </p>
      {chosen && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="text-sm font-semibold">
            {chosen.label}: {formatUsd(chosen.bucket.expectedUsd)}
          </p>
          {chosen.bucket.invoices.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing expected.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {chosen.bucket.invoices.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <button type="button" onClick={() => onOpen(invoice.id)} className="font-semibold hover:underline">
                      {invoice.invoiceNumber}
                    </button>{' '}
                    <span className="text-slate-600">{invoice.buyerName}</span>
                    <span className="block text-xs text-slate-500">
                      Due {invoice.dueDate}, expected {invoice.expectedOn}. {invoice.basis}.
                    </span>
                  </span>
                  <span className="tabular-nums font-semibold">{formatUsd(invoice.balanceUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
};
