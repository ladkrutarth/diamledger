import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, sendJson, type ClosedMonth, type ExportRegisterRow } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { BankDesk } from '../tax/BankDesk';
import { CalendarDesk } from '../tax/CalendarDesk';
import { FilingDesk } from '../tax/FilingDesk';
import { ForexDesk } from '../tax/ForexDesk';
import { RealizationDesk } from '../tax/RealizationDesk';
import { cell, head, thisMonth } from '../tax/shared';
import { Card, Notice, Page, inputClass, primaryButton, secondaryButton } from '../ui';

type Desk = 'calendar' | 'filing' | 'register' | 'bank' | 'realization' | 'forex' | 'months';

interface Props {
  isCharteredAccountant: boolean;
  canWrite: boolean;
  canManage: boolean;
  onOpen: (id: string) => void;
}

export const TaxPage: React.FC<Props> = ({ isCharteredAccountant, canWrite, canManage, onOpen }) => {
  const [desk, setDesk] = useState<Desk>('calendar');
  const [month, setMonth] = useState(thisMonth());
  const [year, setYear] = useState('');
  const [rows, setRows] = useState<ExportRegisterRow[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [taxableUsd, setTaxableUsd] = useState(0);
  const [months, setMonths] = useState<ClosedMonth[] | null>(null);
  const [closeMonth, setCloseMonth] = useState(thisMonth());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (desk !== 'register') return;
    let current = true;
    api<{ month: string; closed: boolean; rows: ExportRegisterRow[]; totals: { taxableUsd: number } }>(
      `/api/tax/register?month=${month}`,
    )
      .then((result) => {
        if (!current) return;
        setRows(result.rows);
        setClosed(result.closed);
        setTaxableUsd(result.totals.taxableUsd);
        setError('');
      })
      .catch((err) => {
        if (current) setError(errorMessage(err, 'Could not load the export register.'));
      });
    return () => {
      current = false;
    };
  }, [desk, month]);

  const loadMonths = () =>
    api<{ financialYear: string; months: ClosedMonth[] }>('/api/tax/months')
      .then((result) => {
        setMonths(result.months);
        setYear((current) => current || result.financialYear);
        setError('');
      })
      .catch((err) => setError(errorMessage(err, 'Could not load closed months.')));

  useEffect(() => {
    if (desk === 'months') loadMonths();
  }, [desk]);

  const setMonthState = async (target: string, action: 'close' | 'open') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/tax/months/${target}/${action}`, sendJson('POST'));
      await loadMonths();
    } catch (err) {
      setError(errorMessage(err, 'Could not update that month.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Tax desk"
      description="Due dates, the GSTR-1 and shipping bill check, bank matching, FEMA realization, exchange differences, and the months a chartered accountant has signed off."
      actions={
        desk === 'register' ? (
          <a href={`/api/tax/gst-pack?month=${month}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            GST pack
          </a>
        ) : desk === 'months' && year ? (
          <a href={`/api/tax/year-pack?year=${year}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            Year pack {year}
          </a>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-1">
        {(
          [
            ['calendar', 'Calendar'],
            ['filing', 'Filing check'],
            ['register', 'Export register'],
            ['bank', 'Bank match'],
            ['realization', 'Realization'],
            ['forex', 'Exchange gain / loss'],
            ['months', 'Closed months'],
          ] as Array<[Desk, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setDesk(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
              desk === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {desk === 'register' && (
        <>
          <Card>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="text-xs font-semibold text-slate-600">
                Month
                <input
                  type="month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                  className={`${inputClass} mt-1`}
                />
              </label>
              <p className="text-sm text-slate-600">
                {rows?.length ?? 0} invoices · taxable {formatUsd(taxableUsd)}
                {closed ? ' · books closed' : ''}
              </p>
            </div>
          </Card>
          <Card>
            {rows === null ? (
              <p className="text-sm text-slate-500">Loading the register...</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-slate-500">No issued invoices in {month}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {['Invoice', 'Buyer', 'Country', 'Scheme', 'Shipping bill', 'Taxable', 'IGST', 'Review'].map((label) => (
                        <th key={label} className={head}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className={cell}>
                          <button type="button" onClick={() => onOpen(row.id)} className="font-semibold text-slate-950 hover:underline">
                            {row.invoiceNumber}
                          </button>
                          <p className="text-xs text-slate-500">{row.invoiceDate}</p>
                        </td>
                        <td className={cell}>{row.buyerName}</td>
                        <td className={cell}>{row.destinationCountry}</td>
                        <td className={cell}>{row.exportScheme === 'igst' ? 'IGST' : 'LUT'}</td>
                        <td className={cell}>
                          {row.shippingBillNo || '—'}
                          {row.shippingBillDate ? <p className="text-xs text-slate-500">{row.shippingBillDate}</p> : null}
                        </td>
                        <td className={`${cell} tabular-nums`}>{formatUsd(row.taxableUsd)}</td>
                        <td className={`${cell} tabular-nums`}>{row.igstUsd ? formatUsd(row.igstUsd) : '—'}</td>
                        <td className={cell}>{row.reviewStatus === 'query' ? 'Query' : row.reviewStatus === 'accepted' ? 'Accepted' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {desk === 'calendar' && <CalendarDesk />}
      {desk === 'filing' && <FilingDesk onOpen={onOpen} />}
      {desk === 'bank' && <BankDesk canWrite={canWrite} onOpen={onOpen} />}
      {desk === 'realization' && <RealizationDesk canManage={canManage} onOpen={onOpen} />}
      {desk === 'forex' && <ForexDesk canWrite={canWrite} onOpen={onOpen} />}

      {desk === 'months' && (
        <>
          <Card title="Financial year pack">
            <p className="text-sm text-slate-600 mb-3">
              One download with the sales register, receipts, outstanding invoices, and cancelled invoices.
            </p>
            <label className="text-xs font-semibold text-slate-600">
              Financial year
              <input value={year} onChange={(event) => setYear(event.target.value)} placeholder="2026-27" className={`${inputClass} mt-1 max-w-xs`} />
            </label>
          </Card>
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
              <p className="mt-2 text-xs text-slate-500">
                After you close a month, invoices in that month cannot be edited and payments cannot be added. You can reopen it.
              </p>
            </Card>
          )}
          <Card title="Closed months">
            {months === null ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : months.length === 0 ? (
              <p className="text-sm text-slate-500">No month has been signed off yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {months.map((item) => (
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
        </>
      )}
    </Page>
  );
};
