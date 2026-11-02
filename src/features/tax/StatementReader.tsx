import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, errorMessage, sendJson, type StatementLine } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, primaryButton, secondaryButton } from '../../components/ui';
import { TableHead, cell } from '../../components/shared';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Reads a PDF, photo, or CSV statement with AI, shows the credits for checking, then imports them. */
export const StatementReader: React.FC<{ onImported: (message: string) => void }> = ({ onImported }) => {
  const [lines, setLines] = useState<Array<StatementLine & { keep: boolean }> | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const read = async (file: File) => {
    setError('');
    setLines(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 10 MB. Split the statement or upload a CSV.');
      return;
    }
    if (/\.(xlsx?|xlsm)$/i.test(file.name)) {
      setError('Excel files cannot be read directly. In Excel use File → Save As → CSV (or PDF), then upload that.');
      return;
    }
    setBusy(true);
    setFileName(file.name);
    try {
      const isText = file.type.startsWith('text/') || /\.(csv|txt)$/i.test(file.name);
      const body = isText ? { text: await file.text() } : { fileBase64: await readAsDataUrl(file), mimeType: file.type };
      const result = await api<{ lines: StatementLine[] }>('/api/bank/parse-statement', sendJson('POST', body));
      setLines(result.lines.map((line) => ({ ...line, keep: true })));
      if (result.lines.length === 0) setError('The AI found no credits in that statement.');
    } catch (err) {
      setError(errorMessage(err, 'Could not read that statement.'));
    } finally {
      setBusy(false);
    }
  };

  const importLines = async () => {
    if (!lines) return;
    setBusy(true);
    setError('');
    try {
      const chosen = lines.filter((line) => line.keep).map(({ keep: _keep, ...line }) => line);
      const result = await api<{ imported: number; duplicates: number; skipped: number }>(
        '/api/bank/import-lines',
        sendJson('POST', { lines: chosen }),
      );
      setLines(null);
      onImported(
        `Imported ${result.imported} credit${result.imported === 1 ? '' : 's'} from ${fileName}.` +
          (result.duplicates ? ` ${result.duplicates} were already imported.` : '') +
          (result.skipped ? ` ${result.skipped} could not be read and were skipped.` : ''),
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not import those lines.'));
    } finally {
      setBusy(false);
    }
  };

  const kept = lines?.filter((line) => line.keep) ?? [];

  return (
    <Card title="Read a statement with AI">
      <p className="text-sm text-slate-600">
        Upload the statement as PDF, a photo or scan (PNG, JPEG), or CSV, in any bank's layout. The AI picks out the credits, and you check
        them before anything is saved. Excel files: save as CSV or PDF first.
      </p>
      <label className={`${primaryButton} mt-3 cursor-pointer`}>
        <Sparkles className="w-3.5 h-3.5" />
        {busy && !lines ? 'Reading...' : 'Choose statement'}
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt,application/pdf,image/*,text/csv"
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) read(file);
          }}
        />
      </label>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {lines && lines.length > 0 && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-700">
            Found {lines.length} credit{lines.length === 1 ? '' : 's'} in {fileName}. Untick anything that is wrong, and compare a few
            amounts with the statement before importing.
          </p>
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <TableHead labels={['', 'Date', 'Amount', 'Reference', 'Narration', 'Rate']} />
              <tbody>
                {lines.map((line, index) => (
                  <tr key={`${line.date}-${line.amountUsd}-${index}`} className={line.keep ? '' : 'opacity-40'}>
                    <td className={cell}>
                      <input
                        type="checkbox"
                        aria-label={`Import the credit of ${formatUsd(line.amountUsd)} on ${line.date}`}
                        checked={line.keep}
                        onChange={() => setLines(lines.map((entry, i) => (i === index ? { ...entry, keep: !entry.keep } : entry)))}
                      />
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>{line.date}</td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>{formatUsd(line.amountUsd)}</td>
                    <td className={cell}>{line.reference || '—'}</td>
                    <td className={`${cell} text-xs`}>{line.narration}</td>
                    <td className={`${cell} tabular-nums`}>{line.bankRateInr ? `₹${line.bankRateInr}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={importLines} disabled={busy || kept.length === 0} className={primaryButton}>
              {busy ? 'Importing...' : `Import ${kept.length} credit${kept.length === 1 ? '' : 's'}`}
            </button>
            <button type="button" onClick={() => setLines(null)} disabled={busy} className={secondaryButton}>
              Discard
            </button>
          </div>
        </div>
      )}
    </Card>
  );
};
