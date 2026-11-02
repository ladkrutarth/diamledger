import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, type RefundReport } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, inputClass, secondaryButton } from '../../components/ui';
import { Badge, InvoiceLink, TableHead, cell, formatInr, thisMonth } from '../../components/shared';

export function financialYearStart(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04`;
}

export const MonthRange: React.FC<{ from: string; to: string; onChange: (from: string, to: string) => void }> = ({ from, to, onChange }) => (
  <div className="flex flex-wrap gap-3">
    <label className="text-xs font-semibold text-slate-600">
      From
      <input type="month" value={from} onChange={(event) => onChange(event.target.value, to)} className={`${inputClass} mt-1`} />
    </label>
    <label className="text-xs font-semibold text-slate-600">
      To
      <input type="month" value={to} onChange={(event) => onChange(from, event.target.value)} className={`${inputClass} mt-1`} />
    </label>
  </div>
);

export const RefundDesk: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [from, setFrom] = useState(financialYearStart());
  const [to, setTo] = useState(thisMonth());
  const [report, setReport] = useState<RefundReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setReport(null);
    api<RefundReport>(`/api/tax/refund-summary?from=${from}&to=${to}`)
      .then((result) => {
        if (!current) return;
        setReport(result);
        setError('');
      })
      .catch((err) => current && setError(errorMessage(err, 'Could not load the refund summary.')));
    return () => {
      current = false;
    };
  }, [from, to]);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <MonthRange from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
          <a href={`/api/tax/refund-summary/csv?from=${from}&to=${to}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            Refund statement CSV
          </a>
        </div>
        {report && (
          <div className="mt-4 grid gap-3 sm:grid-cols-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Exports under LUT</p>
              <p className="text-lg font-semibold">{report.totals.invoices}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ready to claim</p>
              <p className="text-lg font-semibold text-emerald-800">{report.totals.ready}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ready value (INR)</p>
              <p className="text-lg font-semibold">{formatInr(report.totals.readyValueInr)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ready FOB (INR)</p>
              <p className="text-lg font-semibold">{formatInr(report.totals.readyFobInr)}</p>
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Zero-rated exports made under LUT, laid out like Statement 3 of form GST RFD-01 (refund of unutilised input tax credit): invoice,
          shipping bill, port code, FOB value, and the BRC / e-BRC. An invoice is ready when all of these are recorded. Your accountant
          still works out the eligible ITC; this collects the export side.
        </p>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {report === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : report.rows.length === 0 ? (
          <p className="text-sm text-slate-500">No LUT exports between {from} and {to}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Value', 'Shipping bill', 'Port', 'FOB', 'BRC', 'Status']} />
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.invoiceId}>
                    <td className={cell}>
                      <InvoiceLink id={row.invoiceId} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
                      <p className="text-xs text-slate-500">{row.buyerName}</p>
                    </td>
                    <td className={`${cell} tabular-nums`}>
                      {formatUsd(row.totalUsd)}
                      {row.valueInr !== null && <p className="text-xs text-slate-500">{formatInr(row.valueInr)}</p>}
                    </td>
                    <td className={cell}>
                      {row.shippingBillNo || '—'}
                      {row.shippingBillDate && <p className="text-xs text-slate-500">{row.shippingBillDate}</p>}
                    </td>
                    <td className={cell}>{row.portCode || '—'}</td>
                    <td className={`${cell} tabular-nums`}>{row.fobUsd === null ? '—' : formatUsd(row.fobUsd)}</td>
                    <td className={cell}>
                      {row.brcNumber || '—'}
                      {row.brcDate && <p className="text-xs text-slate-500">{row.brcDate}</p>}
                    </td>
                    <td className={cell}>
                      {row.ready ? (
                        <Badge tone="green">Ready</Badge>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.issues.map((issue) => (
                            <li key={issue} className="text-xs text-amber-800">
                              {issue}
                            </li>
                          ))}
                        </ul>
                      )}
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
