import React, { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { api, errorMessage, readFileText, sendJson, type TallyReconcileReport } from '../../api/client';
import { Card, Notice, secondaryButton } from '../../components/ui';
import { MonthRange } from './RefundDesk';
import { Badge, InvoiceLink, Stat, TableHead, cell, previousMonth, useReport } from '../../components/shared';

type Status = TallyReconcileReport['rows'][number]['status'];

const STATUS: Record<Status, { tone: 'green' | 'amber' | 'red' | 'slate'; label: string }> = {
  matched: { tone: 'green', label: 'Matched' },
  amount_differs: { tone: 'red', label: 'Amount differs' },
  date_differs: { tone: 'amber', label: 'Date differs' },
  missing_in_tally: { tone: 'red', label: 'Not in Tally' },
  missing_in_app: { tone: 'amber', label: 'Only in Tally' },
};

const AREAS = { sales: 'Sales', receipts: 'Receipts', purchases: 'Purchases' } as const;

const sanitizeMonth = (value: string, fallback: string): string => (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : fallback);

export const TallyDesk: React.FC<{ canWrite: boolean; onOpen: (id: string) => void }> = ({ canWrite, onOpen }) => {
  const [from, setFrom] = useState(previousMonth());
  const [to, setTo] = useState(previousMonth());
  const [hideMatched, setHideMatched] = useState(true);
  const [message, setMessage] = useState('');
  const safeFrom = sanitizeMonth(from, previousMonth());
  const safeTo = sanitizeMonth(to, previousMonth());
  const query = new URLSearchParams({ from: safeFrom, to: safeTo }).toString();
  const { data, error, setError, reload } = useReport<TallyReconcileReport>(`/api/tally/reconcile?${query}`, 'Could not compare with Tally.');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setMessage('');
    try {
      const result = await api<{ read: number; imported: number; duplicates: number }>('/api/tally/import', sendJson('POST', { content: await readFileText(file) }));
      setMessage(`Read ${result.read} vouchers: ${result.imported} new, ${result.duplicates} already imported.`);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not import the Tally file.'));
    }
  };

  const rows = data?.rows.filter((row) => !hideMatched || row.status !== 'matched') ?? [];

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <MonthRange from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
          <div className="flex gap-2">
            {canWrite && (
              <label className={`${secondaryButton} cursor-pointer`}>
                <Upload className="w-3.5 h-3.5" />
                Import from Tally
                <input type="file" accept=".xml,.csv,text/xml,text/csv" className="hidden" onChange={(event) => upload(event.target.files?.[0])} />
              </label>
            )}
            <a href={`/api/tally/reconcile/csv?${query}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
          </div>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Stat label="Matched" value={data.totals.matched} tone="green" />
            <Stat label="Amount differs" value={data.totals.amountDiffers} tone={data.totals.amountDiffers ? 'red' : undefined} />
            <Stat label="Not in Tally" value={data.totals.missingInTally} tone={data.totals.missingInTally ? 'red' : undefined} />
            <Stat label="Only in Tally" value={data.totals.missingInApp} tone={data.totals.missingInApp ? 'amber' : undefined} />
            <Stat label="Date differs" value={data.totals.dateDiffers} />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          In Tally, open Display → Day Book, set the period, and export it as XML (or Excel saved as CSV). Import it here to compare sales
          vouchers with issued invoices, receipts with payments, and purchase vouchers with recorded purchases. Importing the same file
          twice does not create duplicates.
        </p>
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={hideMatched} onChange={(event) => setHideMatched(event.target.checked)} />
          Hide matched rows
        </label>
      </Card>
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {data && data.vouchersImported === 0 && <Notice>No Tally vouchers imported for this period yet.</Notice>}
      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">{data.rows.length ? 'Everything matches.' : 'Nothing to compare in this period.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Area', 'Reference', 'In the app', 'In Tally', 'Status']} />
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.area}-${row.reference}-${index}`}>
                    <td className={`${cell} text-slate-500`}>{AREAS[row.area]}</td>
                    <td className={cell}>
                      {row.invoiceId ? <InvoiceLink id={row.invoiceId} number={row.reference} onOpen={onOpen} /> : <p className="font-semibold">{row.reference || '—'}</p>}
                      <p className="text-xs text-slate-500">{row.party}</p>
                    </td>
                    <td className={`${cell} tabular-nums`}>
                      {row.appAmount || '—'}
                      {row.appDate && <p className="text-xs text-slate-500">{row.appDate}</p>}
                    </td>
                    <td className={`${cell} tabular-nums`}>
                      {row.tallyAmount || '—'}
                      {row.tallyDate && <p className="text-xs text-slate-500">{row.tallyDate}</p>}
                    </td>
                    <td className={cell}>
                      <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                      {row.detail && <p className="mt-1 text-xs text-slate-600 max-w-xs">{row.detail}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};
