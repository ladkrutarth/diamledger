import React, { useEffect, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { api, errorMessage, queryString, sendJson, type InvoiceSummary } from '../../api/client';
import { formatCarats, formatUsd } from '../../utils/invoiceDefaults';
import { StatusBadge } from '../StatusBadge';
import { Card, Notice, Page, dangerButton, inputClass, primaryButton, secondaryButton } from '../ui';

interface Props {
  isAdmin: boolean;
  initialStatus?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export const InvoicesPage: React.FC<Props> = ({ isAdmin, initialStatus = '', onOpen, onNew }) => {
  const [filters, setFilters] = useState({ q: '', status: initialStatus, from: '', to: '' });
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState('');

  const query = queryString(filters);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api<{ invoices: InvoiceSummary[] }>(`/api/invoices${query}`)
        .then((result) => {
          setInvoices(result.invoices);
          setError('');
        })
        .catch((err) => setError(errorMessage(err, 'Could not load invoices.')));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const update = (key: keyof typeof filters) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters((current) => ({ ...current, [key]: event.target.value }));

  const remove = async (invoice: InvoiceSummary) => {
    if (!window.confirm(`Delete invoice ${invoice.invoiceNumber}? This cannot be undone.`)) return;
    try {
      await api(`/api/invoices/${invoice.id}`, sendJson('DELETE'));
      setInvoices((current) => current?.filter((row) => row.id !== invoice.id) ?? null);
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the invoice.'));
    }
  };

  const totals = (invoices ?? []).reduce(
    (sum, row) => ({ usd: sum.usd + row.totalUsd, due: sum.due + (row.status === 'issued' ? row.dueUsd : 0) }),
    { usd: 0, due: 0 },
  );

  return (
    <Page
      title="Invoices"
      description="Every shipment invoice, from draft to paid. Open a row to see the document, payments, and what is still due."
      actions={
        <>
          <a href={`/api/invoices/export${query}`} className={secondaryButton} download>
            <Download className="w-3.5 h-3.5" />
            Export to Excel (CSV)
          </a>
          <button type="button" onClick={onNew} className={primaryButton}>
            <Plus className="w-3.5 h-3.5" />
            New invoice
          </button>
        </>
      }
    >
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            aria-label="Search invoice number or buyer"
            placeholder="Search invoice number or buyer"
            value={filters.q}
            onChange={update('q')}
            className={inputClass}
          />
          <select aria-label="Status" value={filters.status} onChange={update('status')} className={inputClass}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="issued">Issued (unpaid)</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <input aria-label="From date" type="date" value={filters.from} onChange={update('from')} className={inputClass} />
          <input aria-label="To date" type="date" value={filters.to} onChange={update('to')} className={inputClass} />
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {invoices === null ? (
          <p className="text-sm text-slate-500">Loading invoices...</p>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-slate-500">No invoices match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">Invoice</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Buyer</th>
                  <th className="py-2 pr-3">Destination</th>
                  <th className="py-2 pr-3 text-right">Carats</th>
                  <th className="py-2 pr-3 text-right">Total</th>
                  <th className="py-2 pr-3 text-right">Due</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="py-2 pr-3 font-mono font-semibold text-slate-950">
                      <button type="button" onClick={() => onOpen(row.id)} className="hover:underline text-left">
                        {row.invoiceNumber}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">{row.invoiceDate ?? '—'}</td>
                    <td className="py-2 pr-3">{row.buyerName || '—'}</td>
                    <td className="py-2 pr-3 text-slate-600">{row.destinationCountry || '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCarats(row.totalCarats)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatUsd(row.totalUsd)}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${row.status === 'issued' && row.dueUsd > 0 ? 'font-semibold text-amber-900' : ''}`}>
                      {row.status === 'issued' ? formatUsd(row.dueUsd) : '—'}
                    </td>
                    <td className="py-2 pr-3"><StatusBadge status={row.status} /></td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => onOpen(row.id)} className={secondaryButton}>
                        Open
                      </button>
                      {isAdmin && (
                        <button type="button" onClick={() => remove(row)} className={`${dangerButton} ml-2`}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 font-semibold">
                  <td className="pt-2" colSpan={5}>
                    {invoices.length} invoice{invoices.length === 1 ? '' : 's'}
                  </td>
                  <td className="pt-2 pr-3 text-right tabular-nums">{formatUsd(totals.usd)}</td>
                  <td className="pt-2 pr-3 text-right tabular-nums">{formatUsd(totals.due)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
};
