import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, sendJson, type ForexReport, type ForexRow } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, inputClass, secondaryButton } from '../../components/ui';
import { InvoiceLink, TableHead, cell, formatInr, thisMonth } from '../../components/shared';

const RateInput: React.FC<{ row: ForexRow; disabled: boolean; onSave: (row: ForexRow, rate: string) => void }> = ({ row, disabled, onSave }) => {
  const [value, setValue] = useState(row.bankRateInr === null ? '' : String(row.bankRateInr));
  return (
    <form
      className="flex gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(row, value);
      }}
    >
      <input
        aria-label={`Bank rate for ${row.invoiceNumber}`}
        value={value}
        inputMode="decimal"
        placeholder="₹ / USD"
        onChange={(event) => setValue(event.target.value)}
        className="w-24 border border-slate-300 rounded-md px-2 py-1 text-sm"
        disabled={disabled}
      />
      {!disabled && (
        <button type="submit" className="text-xs font-semibold text-slate-800 hover:underline">
          Save
        </button>
      )}
    </form>
  );
};

export const ForexDesk: React.FC<{ canWrite: boolean; onOpen: (id: string) => void }> = ({ canWrite, onOpen }) => {
  const [month, setMonth] = useState(thisMonth());
  const [report, setReport] = useState<ForexReport | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (target: string) => setReport(await api<ForexReport>(`/api/tax/forex?month=${target}`)), []);

  useEffect(() => {
    let current = true;
    setReport(null);
    api<ForexReport>(`/api/tax/forex?month=${month}`)
      .then((result) => {
        if (!current) return;
        setReport(result);
        setError('');
      })
      .catch((err) => current && setError(errorMessage(err, 'Could not load exchange differences.')));
    return () => {
      current = false;
    };
  }, [month]);

  const saveRate = async (row: ForexRow, rate: string) => {
    setError('');
    try {
      await api(`/api/invoices/${row.invoiceId}/payments/${row.paymentId}`, sendJson('PATCH', { bankRateInr: rate.trim() }));
      await load(month);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the bank rate.'));
    }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs font-semibold text-slate-600">
            Month received
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/tax/forex/tally?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              Tally receipts XML
            </a>
            <a href={`/api/tax/forex/csv?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
          </div>
        </div>
        {report && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3 text-sm">
            <div>
              <p className="text-xs text-slate-500">Exchange gain</p>
              <p className="text-lg font-semibold text-emerald-800">{formatInr(report.totals.gainInr)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Exchange loss</p>
              <p className="text-lg font-semibold text-red-800">{formatInr(report.totals.lossInr)}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Net</p>
              <p className="text-lg font-semibold">{formatInr(report.totals.netInr)}</p>
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          The sale is booked at the customs rate on the invoice; the bank credits rupees at its own rate. The difference is an exchange
          gain or loss. The Tally file has one receipt voucher per payment: bank debited at the bank rate, buyer credited at the invoice
          rate, and the difference posted to "Foreign Exchange Gain / Loss". Payments without a bank rate are left out
          {report?.missingRateCount ? ` (${report.missingRateCount} this month)` : ''}.
          {report?.estimatedCount
            ? ` Using daily reference rates, those payments come to an estimated ${formatInr(report.estimatedNetInr)} net; enter the bank rate for the real figure.`
            : ''}
        </p>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {report === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : report.rows.length === 0 ? (
          <p className="text-sm text-slate-500">No payments received in {month}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Received', 'USD', 'Invoice rate', 'Bank rate', 'Gain / loss']} />
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.paymentId}>
                    <td className={cell}>
                      <InvoiceLink id={row.invoiceId} number={row.invoiceNumber} onOpen={onOpen} />
                      <p className="text-xs text-slate-500">{row.buyerName}</p>
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>{row.paidOn}</td>
                    <td className={`${cell} tabular-nums`}>{formatUsd(row.amountUsd)}</td>
                    <td className={`${cell} tabular-nums`}>
                      {row.invoiceRateInr ? (
                        `₹${row.invoiceRateInr}`
                      ) : row.referenceInvoiceRateInr ? (
                        <span className="text-slate-500" title="Daily reference rate; the invoice has no rate">
                          ≈ ₹{row.referenceInvoiceRateInr} <span className="text-[10px]">ref</span>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={cell}>
                      <RateInput key={`${row.paymentId}-${row.bankRateInr}`} row={row} disabled={!canWrite} onSave={saveRate} />
                      {row.bankRateInr === null && row.referenceBankRateInr !== null && (
                        <p className="mt-0.5 text-[11px] text-slate-500">Reference rate that day: ₹{row.referenceBankRateInr}</p>
                      )}
                    </td>
                    <td className={`${cell} tabular-nums font-semibold ${row.gainInr === null ? 'text-slate-400' : row.gainInr >= 0 ? 'text-emerald-800' : 'text-red-800'}`}>
                      {row.gainInr !== null ? (
                        formatInr(row.gainInr)
                      ) : row.estimatedGainInr !== null ? (
                        <span className="font-normal text-slate-500" title="Estimate from reference rates. Enter the bank rate for the real figure.">
                          ≈ {formatInr(row.estimatedGainInr)} (est.)
                        </span>
                      ) : (
                        'Needs bank rate'
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
