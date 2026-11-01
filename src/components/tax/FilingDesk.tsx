import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, errorMessage, type FilingCheck } from '../../api/client';
import { Card, Notice, inputClass, secondaryButton } from '../ui';
import { Badge, InvoiceLink, TableHead, cell, previousMonth } from './shared';

export const FilingDesk: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [month, setMonth] = useState(previousMonth());
  const [check, setCheck] = useState<FilingCheck | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setCheck(null);
    api<FilingCheck>(`/api/tax/filing-check?month=${month}`)
      .then((result) => {
        if (!current) return;
        setCheck(result);
        setError('');
      })
      .catch((err) => {
        if (current) setError(errorMessage(err, 'Could not run the filing check.'));
      });
    return () => {
      current = false;
    };
  }, [month]);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs font-semibold text-slate-600">
            Return period
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/tax/gstr1-6a?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              GSTR-1 table 6A JSON
            </a>
            <a href={`/api/tax/einvoice-batch?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              e-invoice bulk JSON
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Customs matches each shipping bill against table 6A of GSTR-1 before it refunds IGST. This check compares the shipping bill
          number, date, port code, invoice number, and value with the invoice. The GSTR-1 file only includes invoices that pass. The
          e-invoice file is in the portal's bulk upload format for invoices that have no IRN yet; after the portal returns the IRN,
          record it on the invoice.
        </p>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {check?.companyIssues.map((issue) => (
        <Notice key={issue.code} tone="error">
          {issue.message}
        </Notice>
      ))}

      <Card>
        {check === null ? (
          <p className="text-sm text-slate-500">Checking {month}...</p>
        ) : check.rows.length === 0 ? (
          <p className="text-sm text-slate-500">No issued invoices in {month}.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-600">
              {check.readyCount} ready to file · {check.issueCount} need fixing
              {check.issueCount > 0 ? ' and are left out of the GSTR-1 file' : ''}.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead labels={['Invoice', 'Scheme', 'Shipping bill', 'IRN', 'Result']} />
                <tbody>
                  {check.rows.map((row) => (
                    <tr key={row.id}>
                      <td className={cell}>
                        <InvoiceLink id={row.id} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
                      </td>
                      <td className={cell}>{row.exportScheme === 'igst' ? 'IGST paid' : 'LUT'}</td>
                      <td className={cell}>{row.shippingBillNo || '—'}</td>
                      <td className={`${cell} font-mono text-xs`}>{row.irn ? `${row.irn.slice(0, 10)}…` : '—'}</td>
                      <td className={cell}>
                        {row.ready ? (
                          <Badge tone="green">Ready</Badge>
                        ) : (
                          <ul className="space-y-1">
                            {row.issues.map((issue) => (
                              <li key={issue.code} className="text-xs text-red-800">
                                {issue.message}
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
          </>
        )}
      </Card>
    </>
  );
};
