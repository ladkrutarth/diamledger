import React, { useEffect, useState } from 'react';
import { Gem } from 'lucide-react';
import { api, errorMessage, type PortalInvoice, type PortalView } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { A1005InvoicePreview } from '../invoices/A1005InvoicePreview';
import { Badge, TableHead, cell } from '../../components/shared';
import { Card, Notice, secondaryButton } from '../../components/ui';

/** What a buyer sees when they open a private portal link. No sign-in; read-only. */
export const PortalPage: React.FC<{ token: string }> = ({ token }) => {
  const [view, setView] = useState<PortalView | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<PortalInvoice | null>(null);

  useEffect(() => {
    api<PortalView>(`/api/portal/${encodeURIComponent(token)}`)
      .then(setView)
      .catch((err) => setError(errorMessage(err, 'This link could not be opened.')));
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-100 text-stone-800">
      <header className="bg-stone-950 text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
            <Gem className="w-4 h-4 text-amber-200" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{view?.exporterName ?? 'Invoices'}</p>
            {view && <p className="text-xs text-stone-400">Statement for {view.buyerName}</p>}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-7 space-y-5">
        {error && <Notice tone="error">{error}</Notice>}
        {!view && !error && <p className="text-sm text-slate-500">Loading...</p>}

        {view && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <p className="text-xs text-slate-500">Invoices</p>
                <p className="text-2xl font-semibold">{view.totals.invoices}</p>
              </Card>
              <Card>
                <p className="text-xs text-slate-500">Balance due</p>
                <p className="text-2xl font-semibold tabular-nums">{formatUsd(view.totals.dueUsd)}</p>
              </Card>
              <Card>
                <p className="text-xs text-slate-500">Past due</p>
                <p className={`text-2xl font-semibold tabular-nums ${view.totals.overdueUsd > 0 ? 'text-red-700' : ''}`}>
                  {formatUsd(view.totals.overdueUsd)}
                </p>
              </Card>
            </div>

            <Card>
              {view.invoices.length === 0 ? (
                <p className="text-sm text-slate-500">There are no invoices to show yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <TableHead labels={['Invoice', 'Date', 'Due date', 'Amount', 'Paid', 'Balance', '']} />
                    <tbody>
                      {view.invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <td className={`${cell} font-semibold whitespace-nowrap`}>{invoice.invoiceNumber}</td>
                          <td className={`${cell} whitespace-nowrap`}>{invoice.invoiceDate}</td>
                          <td className={`${cell} whitespace-nowrap`}>
                            {invoice.dueDate}
                            {invoice.overdue && (
                              <span className="ml-2">
                                <Badge tone="red">Past due</Badge>
                              </span>
                            )}
                          </td>
                          <td className={`${cell} tabular-nums`}>{formatUsd(invoice.totalUsd)}</td>
                          <td className={`${cell} tabular-nums`}>{formatUsd(invoice.paidUsd)}</td>
                          <td className={`${cell} tabular-nums font-semibold`}>
                            {invoice.dueUsd > 0 ? formatUsd(invoice.dueUsd) : <Badge tone="green">Paid</Badge>}
                          </td>
                          <td className={`${cell} text-right`}>
                            <button type="button" onClick={() => setOpen(invoice)} className={secondaryButton}>
                              View / download
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-slate-500">
                This private link was shared by {view.exporterName} and works until {new Date(view.expiresAt).toLocaleDateString()}. For
                questions about an invoice or a payment, contact them directly.
              </p>
            </Card>

            {open && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Invoice {open.invoiceNumber}</h2>
                  <button type="button" onClick={() => setOpen(null)} className={secondaryButton}>
                    Close
                  </button>
                </div>
                <div className="bg-white border border-stone-200 rounded-xl overflow-auto">
                  <A1005InvoicePreview key={open.id} invoice={open.invoice} />
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};
