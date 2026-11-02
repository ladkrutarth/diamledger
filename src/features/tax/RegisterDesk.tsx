import React, { useState } from 'react';
import { Download } from 'lucide-react';
import type { ExportRegisterRow } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Badge, InvoiceLink, TableHead, cell, thisMonth, useReport } from '../../components/shared';
import { Card, Notice, inputClass, secondaryButton } from '../../components/ui';

/** Issued invoices for one month with their scheme, shipping bill, and the CA's review; and the GST pack download. */
export const RegisterDesk: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [month, setMonth] = useState(thisMonth());
  const { data, error } = useReport<{ month: string; closed: boolean; rows: ExportRegisterRow[]; totals: { taxableUsd: number } }>(
    `/api/tax/register?month=${month}`,
    'Could not load the export register.',
  );
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs font-semibold text-slate-600">
            Month
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <div className="flex items-center gap-3">
            {data && (
              <p className="text-sm text-slate-600">
                {data.rows.length} invoices · taxable {formatUsd(data.totals.taxableUsd)}
                {data.closed ? ' · books closed' : ''}
              </p>
            )}
            <a href={`/api/tax/gst-pack?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              GST pack
            </a>
          </div>
        </div>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading the register...</p>
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-slate-500">No issued invoices in {month}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Buyer', 'Country', 'Scheme', 'Shipping bill', 'Taxable', 'IGST', 'Review']} />
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={cell}>
                      <InvoiceLink id={row.id} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
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
                    <td className={cell}>
                      {row.reviewStatus === 'query' ? <Badge tone="amber">Query</Badge> : row.reviewStatus === 'accepted' ? <Badge tone="green">Accepted</Badge> : '—'}
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
