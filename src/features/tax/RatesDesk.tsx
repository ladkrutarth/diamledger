import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, errorMessage, sendJson, type RatesReport } from '../../api/client';
import { Card, Notice, dangerButton, inputClass, primaryButton, secondaryButton } from '../../components/ui';
import { TableHead, cell } from '../../components/shared';

export const RatesDesk: React.FC<{ canManage: boolean }> = ({ canManage }) => {
  const [report, setReport] = useState<RatesReport | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), rateInr: '', note: '' });

  const load = useCallback(async () => {
    const result = await api<RatesReport>('/api/rates');
    setReport(result);
    if (result.refreshError) setError(result.refreshError);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err, 'Could not load exchange rates.')));
  }, [load]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setNotice(await work());
      await load();
    } catch (err) {
      setError(errorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = () =>
    run(async () => {
      const result = await api<{ added: number; latest: string | null }>('/api/rates/refresh', sendJson('POST'));
      return result.added ? `Added ${result.added} day${result.added === 1 ? '' : 's'} of rates.` : 'Rates are already up to date.';
    });

  const saveCompanyRate = (event: React.FormEvent) => {
    event.preventDefault();
    run(async () => {
      await api('/api/rates/company', sendJson('PUT', { date: form.date, rateInr: Number(form.rateInr), note: form.note }));
      setForm({ ...form, rateInr: '', note: '' });
      return `Saved the company rate for ${form.date}.`;
    });
  };

  const removeCompanyRate = (date: string) =>
    run(async () => {
      await api(`/api/rates/company/${date}`, sendJson('DELETE'));
      return `Removed the company rate for ${date}.`;
    });

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500">Today's rate (USD → INR)</p>
            <p className="text-2xl font-semibold tabular-nums">{report?.latest ? `₹${report.latest.rateInr.toFixed(4)}` : '—'}</p>
            {report?.latest && (
              <p className="text-xs text-slate-500">
                {report.latest.source}, dated {report.latest.date}
              </p>
            )}
          </div>
          {canManage && (
            <button type="button" onClick={refresh} disabled={busy} className={secondaryButton}>
              <RefreshCw className="w-3.5 h-3.5" />
              Fetch latest rates
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Reference rates are fetched every day from {report?.source ?? 'the rate source'}, which publishes the European Central Bank
          reference rate. RBI does not offer a public feed. When an invoice or a payment has no rate, the exchange gain / loss report uses
          these rates to show an estimate; estimates are never posted to Tally. Enter the customs notified rate or your bank's rate below
          and it is used instead of the reference rate for the following month.
        </p>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      {canManage && (
        <Card title="Add a company rate">
          <form onSubmit={saveCompanyRate} className="grid gap-3 sm:grid-cols-4 items-end">
            <label className="text-xs font-semibold text-slate-600">
              Date
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={`${inputClass} mt-1`} required />
            </label>
            <label className="text-xs font-semibold text-slate-600">
              ₹ per USD
              <input
                inputMode="decimal"
                value={form.rateInr}
                onChange={(e) => setForm({ ...form, rateInr: e.target.value })}
                placeholder="e.g. 94.85"
                className={`${inputClass} mt-1`}
                required
              />
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Note
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Customs notification no."
                className={`${inputClass} mt-1`}
              />
            </label>
            <button type="submit" disabled={busy} className={primaryButton}>
              Save rate
            </button>
          </form>
        </Card>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Company rates">
          {!report ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : report.company.length === 0 ? (
            <p className="text-sm text-slate-500">None entered in the last 45 days.</p>
          ) : (
            <table className="w-full text-sm">
              <TableHead labels={['Date', 'Rate', 'Note', '']} />
              <tbody>
                {report.company.map((rate) => (
                  <tr key={rate.date}>
                    <td className={cell}>{rate.date}</td>
                    <td className={`${cell} tabular-nums`}>₹{rate.rateInr.toFixed(4)}</td>
                    <td className={cell}>{rate.note}</td>
                    <td className={`${cell} text-right`}>
                      {canManage && (
                        <button type="button" onClick={() => removeCompanyRate(rate.date)} disabled={busy} className={dangerButton}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Reference rates (last 45 days)">
          {!report ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : report.reference.length === 0 ? (
            <p className="text-sm text-slate-500">No reference rates stored yet. Fetch the latest rates.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <TableHead labels={['Date', 'Rate']} />
                <tbody>
                  {report.reference.map((rate) => (
                    <tr key={rate.date}>
                      <td className={cell}>{rate.date}</td>
                      <td className={`${cell} tabular-nums`}>₹{rate.rateInr.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
};
