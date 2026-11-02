import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, sendJson, type ClosedMonth } from '../../api/client';
import { thisMonth, useReport } from '../../components/shared';
import { Card, Notice, inputClass, primaryButton, secondaryButton } from '../../components/ui';

/** The CA signs off months; nothing dated in a closed month can change until it is reopened. */
export const MonthsDesk: React.FC<{ isCharteredAccountant: boolean }> = ({ isCharteredAccountant }) => {
  const { data, error, setError, reload } = useReport<{ financialYear: string; months: ClosedMonth[] }>('/api/tax/months', 'Could not load closed months.');
  const [year, setYear] = useState('');
  const [closeMonth, setCloseMonth] = useState(thisMonth());
  const [busy, setBusy] = useState(false);
  const packYear = year || data?.financialYear || '';

  const setMonthState = async (target: string, action: 'close' | 'open') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/tax/months/${target}/${action}`, sendJson('POST'));
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not update that month.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {isCharteredAccountant && (
        <Card title="Sign off a month">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setMonthState(closeMonth, 'close');
            }}
          >
            <label className="text-xs font-semibold text-slate-600">
              Month
              <input type="month" value={closeMonth} onChange={(event) => setCloseMonth(event.target.value)} className={`${inputClass} mt-1`} />
            </label>
            <button type="submit" disabled={busy} className={primaryButton}>
              Close month
            </button>
          </form>
          <p className="mt-2 text-xs text-slate-500">After you close a month, invoices in it cannot be edited and payments cannot be added. You can reopen it.</p>
        </Card>
      )}
      <Card title="Closed months">
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : data.months.length === 0 ? (
          <p className="text-sm text-slate-500">No month has been signed off yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.months.map((item) => (
              <li key={item.month} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <p className="font-semibold text-slate-950">{item.month}</p>
                  <p className="text-xs text-slate-500">
                    Closed {item.closedAt.slice(0, 10)}
                    {item.closedBy ? ` by ${item.closedBy}` : ''}
                  </p>
                </div>
                {isCharteredAccountant && (
                  <button type="button" disabled={busy} onClick={() => setMonthState(item.month, 'open')} className={secondaryButton}>
                    Reopen
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Financial year pack">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-slate-600 max-w-md">One download with the sales register, receipts, outstanding invoices, and cancelled invoices for the year.</p>
          <div className="flex items-end gap-2">
            <label className="text-xs font-semibold text-slate-600">
              Financial year
              <input value={packYear} onChange={(event) => setYear(event.target.value)} placeholder="2026-27" className={`${inputClass} mt-1 w-28`} />
            </label>
            {packYear && (
              <a href={`/api/tax/year-pack?year=${packYear}`} className={secondaryButton}>
                <Download className="w-3.5 h-3.5" />
                Year pack
              </a>
            )}
          </div>
        </div>
      </Card>
    </>
  );
};
