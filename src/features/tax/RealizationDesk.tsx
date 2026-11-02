import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, sendJson, type RealizationReport, type RealizationRow, type TaxSettings } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, inputClass, primaryButton, secondaryButton } from '../../components/ui';
import { Badge, InvoiceLink, TableHead, cell } from '../../components/shared';

type Filter = 'attention' | 'all';

function FlagBadge({ row }: { row: RealizationRow }) {
  if (row.flag === 'overdue') return <Badge tone="red">{-row.daysLeft} days past deadline</Badge>;
  if (row.flag === 'due_soon') return <Badge tone="amber">{row.daysLeft} days left</Badge>;
  if (row.flag === 'open') return <Badge tone="slate">{row.daysLeft} days left</Badge>;
  if (row.flag === 'needs_brc') return <Badge tone="amber">Paid, waiting for e-BRC</Badge>;
  return <Badge tone="green">Realized</Badge>;
}

export const RealizationDesk: React.FC<{ canManage: boolean; onOpen: (id: string) => void }> = ({ canManage, onOpen }) => {
  const [report, setReport] = useState<RealizationReport | null>(null);
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [nextReport, nextSettings] = await Promise.all([
      api<RealizationReport>('/api/tax/realization'),
      api<TaxSettings>('/api/tax/settings'),
    ]);
    setReport(nextReport);
    setSettings(nextSettings);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err, 'Could not load realization.')));
  }, [load]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice(await work());
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };

  const rows = report?.rows.filter((row) => filter === 'all' || row.flag !== 'done') ?? [];

  return (
    <>
      {report && (
        <Card>
          <div className="grid gap-3 sm:grid-cols-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Still to realize</p>
              <p className="text-lg font-semibold">{formatUsd(report.openUsd)}</p>
              <p className="text-xs text-slate-500">{report.openCount} invoices</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Past the deadline</p>
              <p className="text-lg font-semibold text-red-800">{report.overdueCount}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Due within 30 days</p>
              <p className="text-lg font-semibold text-amber-800">{report.dueSoonCount}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Paid but no e-BRC</p>
              <p className="text-lg font-semibold">{report.needsBrcCount}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Deadline = shipping bill date (or invoice date) + {report.realizationMonths} months, the period this company follows under
            FEMA. Check the current RBI limit and change it below if it differs. Overdue bills show up as outstanding in EDPMS until the
            bank reports realization.
          </p>
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      {canManage && settings && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Tax settings">
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  await api('/api/tax/settings', sendJson('PUT', settings));
                  return 'Settings saved.';
                });
              }}
            >
              <label className="text-xs font-semibold text-slate-600">
                Realization period (months)
                <input
                  type="number"
                  min={1}
                  max={36}
                  value={settings.realizationMonths}
                  onChange={(event) => setSettings({ ...settings, realizationMonths: Number(event.target.value) })}
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Current LUT valid until
                <input
                  type="date"
                  value={settings.lutValidUntil ?? ''}
                  onChange={(event) => setSettings({ ...settings, lutValidUntil: event.target.value || null })}
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={settings.einvoiceRequired}
                  onChange={(event) => setSettings({ ...settings, einvoiceRequired: event.target.checked })}
                />
                e-invoicing applies (aggregate turnover above ₹5 crore)
              </label>
              <div>
                <button type="submit" disabled={busy} className={primaryButton}>
                  Save settings
                </button>
              </div>
            </form>
          </Card>
          <Card title="Import e-BRC">
            <p className="text-sm text-slate-600">
              Download the e-BRC list from the DGFT portal as CSV and upload it here. Each row is matched to an invoice by shipping bill
              number or invoice number, and that invoice is marked realized.
            </p>
            <label className={`${secondaryButton} mt-3 cursor-pointer`}>
              {busy ? 'Working...' : 'Choose e-BRC CSV'}
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  run(async () => {
                    const result = await api<{ matched: number; unmatched: string[] }>(
                      '/api/tax/ebrc/import',
                      sendJson('POST', { csv: await file.text() }),
                    );
                    return (
                      `${result.matched} e-BRC${result.matched === 1 ? '' : 's'} matched.` +
                      (result.unmatched.length ? ` No invoice found for: ${result.unmatched.slice(0, 8).join(', ')}.` : '')
                    );
                  });
                }}
              />
            </label>
          </Card>
        </div>
      )}

      <Card>
        <div className="mb-3 flex gap-1">
          {(
            [
              ['attention', 'Needs attention'],
              ['all', 'All'],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                filter === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {report === null ? (
          <p className="text-sm text-slate-500">Loading realization...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing needs attention.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Buyer', 'Shipped', 'Deadline', 'Received', 'Open', 'Bank reference / e-BRC', 'Status']} />
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className={cell}>
                      <InvoiceLink id={row.id} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
                    </td>
                    <td className={cell}>{row.buyerName}</td>
                    <td className={`${cell} whitespace-nowrap`}>{row.shippedOn}</td>
                    <td className={`${cell} whitespace-nowrap`}>{row.deadline}</td>
                    <td className={`${cell} whitespace-nowrap tabular-nums`}>{formatUsd(row.paidUsd)}</td>
                    <td className={`${cell} whitespace-nowrap tabular-nums`}>{row.dueUsd ? formatUsd(row.dueUsd) : '—'}</td>
                    <td className={cell}>
                      {row.bankReferences || '—'}
                      {row.brcNumber && <p className="text-xs text-emerald-800">e-BRC {row.brcNumber} · {row.brcDate}</p>}
                      {row.missingReference && <p className="text-xs text-amber-800">Payment has no bank reference</p>}
                    </td>
                    <td className={cell}>
                      <FlagBadge row={row} />
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
