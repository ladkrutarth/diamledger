import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, sendJson, type BankLine } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, primaryButton, secondaryButton } from '../../components/ui';
import { Badge, TableHead, cell } from '../../components/shared';
import { StatementReader } from './StatementReader';

type Status = BankLine['status'];

export const BankDesk: React.FC<{ canWrite: boolean; onOpen: (id: string) => void }> = ({ canWrite, onOpen }) => {
  const [status, setStatus] = useState<Status>('unmatched');
  const [lines, setLines] = useState<BankLine[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Status, number>>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (target: Status) => {
    const result = await api<{ lines: BankLine[]; counts: Partial<Record<Status, number>> }>(`/api/bank/lines?status=${target}`);
    setLines(result.lines);
    setCounts(result.counts);
    setChosen(Object.fromEntries(result.lines.map((line) => [line.id, line.suggestions[0]?.invoiceId ?? ''])));
  }, []);

  useEffect(() => {
    let current = true;
    setLines(null);
    load(status)
      .then(() => current && setError(''))
      .catch((err) => current && setError(errorMessage(err, 'Could not load bank lines.')));
    return () => {
      current = false;
    };
  }, [status, load]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ imported: number; duplicates: number; skipped: number }>(
        '/api/bank/import',
        sendJson('POST', { csv: await file.text() }),
      );
      setNotice(
        `Imported ${result.imported} credit${result.imported === 1 ? '' : 's'}.` +
          (result.duplicates ? ` ${result.duplicates} were already imported.` : '') +
          (result.skipped ? ` ${result.skipped} rows were debits or unreadable and were skipped.` : ''),
      );
      setStatus('unmatched');
      await load('unmatched');
    } catch (err) {
      setError(errorMessage(err, 'Could not import the statement.'));
    } finally {
      setBusy(false);
    }
  };

  const act = async (line: BankLine, action: 'match' | 'ignore') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'match') {
        const result = await api<{ dueUsd: number }>(`/api/bank/lines/${line.id}/match`, sendJson('POST', { invoiceId: chosen[line.id] }));
        const invoice = line.suggestions.find((suggestion) => suggestion.invoiceId === chosen[line.id]);
        setNotice(
          `${formatUsd(line.amountUsd)} recorded against ${invoice?.invoiceNumber ?? 'the invoice'}.` +
            (result.dueUsd > 0 ? ` ${formatUsd(result.dueUsd)} is still open on it.` : ' It is now fully paid.'),
        );
      } else {
        await api(`/api/bank/lines/${line.id}/ignore`, sendJson('POST'));
      }
      await load(status);
    } catch (err) {
      setError(errorMessage(err, 'Could not update that bank line.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="Import a bank statement">
        <p className="text-sm text-slate-600">
          Upload the USD account statement as CSV. It needs a date column and a credit (or amount) column; reference, narration, and the
          bank's rupee rate are read when present. Debits are skipped, and a line already imported is not added twice. Convert MT940 or
          MT103 files to CSV in your banking portal first.
        </p>
        {canWrite && (
          <label className={`${primaryButton} mt-3 cursor-pointer`}>
            {busy ? 'Working...' : 'Choose CSV'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) upload(file);
              }}
            />
          </label>
        )}
      </Card>

      {canWrite && (
        <StatementReader
          onImported={async (message) => {
            setError('');
            setNotice(message);
            setStatus('unmatched');
            await load('unmatched').catch(() => undefined);
          }}
        />
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      <div className="flex gap-1">
        {(['unmatched', 'matched', 'ignored'] as Status[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatus(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg capitalize ${
              status === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'
            }`}
          >
            {key} ({counts[key] ?? 0})
          </button>
        ))}
      </div>

      <Card>
        {lines === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-slate-500">No {status} bank lines.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={status === 'unmatched' ? ['Date', 'Credit', 'Narration', 'Suggested invoice', ''] : ['Date', 'Credit', 'Narration', 'Invoice']} />
              <tbody>
                {lines.map((line) => {
                  const selected = line.suggestions.find((suggestion) => suggestion.invoiceId === chosen[line.id]);
                  return (
                    <tr key={line.id}>
                      <td className={cell}>{line.lineDate}</td>
                      <td className={`${cell} tabular-nums`}>
                        {formatUsd(line.amountUsd)}
                        {line.bankRateInr ? <p className="text-xs text-slate-500">₹{line.bankRateInr} / USD</p> : null}
                      </td>
                      <td className={`${cell} max-w-xs`}>
                        <p className="break-words">{line.narration || '—'}</p>
                        {line.reference ? <p className="text-xs text-slate-500">Ref {line.reference}</p> : null}
                      </td>
                      {status === 'unmatched' ? (
                        <>
                          <td className={cell}>
                            {line.suggestions.length === 0 ? (
                              <span className="text-xs text-slate-500">No likely invoice. Record it on the invoice by hand.</span>
                            ) : (
                              <>
                                <select
                                  value={chosen[line.id] ?? ''}
                                  onChange={(event) => setChosen({ ...chosen, [line.id]: event.target.value })}
                                  className="border border-slate-300 rounded-md px-2 py-1 text-sm"
                                  disabled={!canWrite}
                                >
                                  {line.suggestions.map((suggestion) => (
                                    <option key={suggestion.invoiceId} value={suggestion.invoiceId}>
                                      {suggestion.invoiceNumber} · {suggestion.buyerName} · {formatUsd(suggestion.dueUsd)} due
                                    </option>
                                  ))}
                                </select>
                                {selected && (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    <Badge tone={selected.score >= 70 ? 'green' : 'amber'}>{selected.score}% match</Badge>
                                    {selected.reasons.map((reason) => (
                                      <Badge key={reason} tone={reason.startsWith('Short') || reason === 'Part payment' ? 'amber' : 'slate'}>
                                        {reason}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                          <td className={`${cell} whitespace-nowrap`}>
                            {canWrite && (
                              <div className="flex gap-1">
                                {line.suggestions.length > 0 && (
                                  <button type="button" disabled={busy} onClick={() => act(line, 'match')} className={primaryButton}>
                                    Confirm
                                  </button>
                                )}
                                <button type="button" disabled={busy} onClick={() => act(line, 'ignore')} className={secondaryButton}>
                                  Not a sale
                                </button>
                              </div>
                            )}
                          </td>
                        </>
                      ) : (
                        <td className={cell}>
                          {line.invoiceId && line.invoiceNumber ? (
                            <button type="button" onClick={() => onOpen(line.invoiceId as string)} className="font-semibold hover:underline">
                              {line.invoiceNumber}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};
