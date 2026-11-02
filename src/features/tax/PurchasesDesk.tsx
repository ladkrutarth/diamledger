import React, { useState } from 'react';
import { Download, Plus, Upload } from 'lucide-react';
import { api, errorMessage, readFileText, sendJson, type ItcMatch, type ItcStatus, type Purchase } from '../../api/client';
import { Card, Field, Notice, dangerButton, inputClass, primaryButton, secondaryButton } from '../../components/ui';
import { financialYearStart, MonthRange } from './RefundDesk';
import { Badge, CheckField, SelectField, Stat, TableHead, cell, formatInr, previousMonth, thisMonth, useReport } from '../../components/shared';

const ITC_STATUS: Record<ItcStatus, { tone: 'green' | 'amber' | 'red' | 'slate'; label: string }> = {
  matched: { tone: 'green', label: 'Matched' },
  mismatch: { tone: 'amber', label: 'Amount differs' },
  missing_in_2b: { tone: 'red', label: 'Not in GSTR-2B' },
  not_in_books: { tone: 'amber', label: 'Not in books' },
  itc_blocked: { tone: 'slate', label: 'Credit not available' },
};

type Form = {
  id: string | null;
  kind: 'import' | 'local';
  supplierName: string;
  supplierGstin: string;
  supplierCountry: string;
  documentNo: string;
  documentDate: string;
  portCode: string;
  description: string;
  carats: string;
  parcelId: string;
  taxableInr: string;
  igstInr: string;
  cgstInr: string;
  sgstInr: string;
  relatedParty: boolean;
  notes: string;
};

const blank = (): Form => ({
  id: null, kind: 'local', supplierName: '', supplierGstin: '', supplierCountry: '', documentNo: '',
  documentDate: new Date().toISOString().slice(0, 10), portCode: '', description: '', carats: '', parcelId: '', taxableInr: '',
  igstInr: '', cgstInr: '', sgstInr: '', relatedParty: false, notes: '',
});

const fromPurchase = (purchase: Purchase): Form => ({
  ...purchase,
  carats: purchase.carats ? String(purchase.carats) : '',
  taxableInr: String(purchase.taxableInr),
  igstInr: purchase.igstInr ? String(purchase.igstInr) : '',
  cgstInr: purchase.cgstInr ? String(purchase.cgstInr) : '',
  sgstInr: purchase.sgstInr ? String(purchase.sgstInr) : '',
});

const ItcMatchCard: React.FC<{ canWrite: boolean }> = ({ canWrite }) => {
  const [month, setMonth] = useState(previousMonth());
  const { data, error, setError, reload } = useReport<ItcMatch>(`/api/purchases/itc-match?month=${month}`, 'Could not load the GSTR-2B match.');
  const [message, setMessage] = useState('');

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setMessage('');
    try {
      const result = await api<{ imported: number; skipped: number }>('/api/purchases/gstr2b', sendJson('POST', { month, csv: await readFileText(file) }));
      setMessage(`Imported ${result.imported} GSTR-2B lines for ${month}${result.skipped ? ` (${result.skipped} rows skipped)` : ''}.`);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not import the GSTR-2B file.'));
    }
  };

  return (
    <>
      <Card title="Input tax credit: books vs GSTR-2B">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="text-xs font-semibold text-slate-600">
            Return month
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <div className="flex gap-2">
            {canWrite && (
              <label className={`${secondaryButton} cursor-pointer`}>
                <Upload className="w-3.5 h-3.5" />
                Import GSTR-2B CSV
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => upload(event.target.files?.[0])} />
              </label>
            )}
            <a href={`/api/purchases/itc-match/csv?month=${month}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
          </div>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Stat label="Credit in books" value={formatInr(data.totals.booksItcInr)} />
            <Stat label="Available in 2B" value={formatInr(data.totals.gstr2bItcInr)} />
            <Stat label="Matched" value={formatInr(data.totals.matchedItcInr)} tone="green" />
            <Stat label="At risk (supplier not filed)" value={formatInr(data.totals.atRiskItcInr)} tone={data.totals.atRiskItcInr ? 'red' : undefined} />
            <Stat label="In 2B, not claimed" value={formatInr(data.totals.unclaimedItcInr)} tone={data.totals.unclaimedItcInr ? 'amber' : undefined} />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Download GSTR-2B from the GST portal (Returns → GSTR-2B → Download Excel), save the B2B and IMPG sheets as CSV, and import them
          here. Purchases are matched on supplier GSTIN and invoice number, and imports on the Bill of Entry number. A purchase can match a
          2B line from a later month when the supplier filed late.
        </p>
      </Card>
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {data && !data.gstr2bImported && (
        <Notice>GSTR-2B for {month} has not been imported yet, so every purchase shows as not in GSTR-2B.</Notice>
      )}
      {data && data.rows.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Supplier', 'Invoice / BoE', 'Tax in books', 'Tax in 2B', 'Status']} />
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={`${row.status}-${row.documentNo}-${index}`}>
                    <td className={cell}>
                      <p className="font-semibold">{row.supplierName || '—'}</p>
                      <p className="text-xs text-slate-500">{row.kind === 'import' ? 'Import' : row.supplierGstin || 'No GSTIN'}</p>
                    </td>
                    <td className={cell}>
                      {row.documentNo}
                      {row.documentDate && <p className="text-xs text-slate-500">{row.documentDate}</p>}
                    </td>
                    <td className={`${cell} tabular-nums`}>{row.booksTaxInr === null ? '—' : formatInr(row.booksTaxInr)}</td>
                    <td className={`${cell} tabular-nums`}>
                      {row.gstr2bTaxInr === null ? '—' : formatInr(row.gstr2bTaxInr)}
                      {row.gstr2bMonth && row.gstr2bMonth !== month && <p className="text-xs text-slate-500">2B of {row.gstr2bMonth}</p>}
                    </td>
                    <td className={cell}>
                      <Badge tone={ITC_STATUS[row.status].tone}>{ITC_STATUS[row.status].label}</Badge>
                      {row.detail && <p className="mt-1 text-xs text-slate-600 max-w-xs">{row.detail}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
};

export const PurchasesDesk: React.FC<{ canWrite: boolean; canManage: boolean }> = ({ canWrite, canManage }) => {
  const [from, setFrom] = useState(financialYearStart());
  const [to, setTo] = useState(thisMonth());
  const { data, error, setError, reload } = useReport<{ purchases: Purchase[]; totals: { taxableInr: number; taxInr: number; carats: number } }>(
    `/api/purchases?from=${from}&to=${to}`,
    'Could not load purchases.',
  );
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => form && setForm({ ...form, [key]: value });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      await api(form.id ? `/api/purchases/${form.id}` : '/api/purchases', sendJson(form.id ? 'PUT' : 'POST', form));
      setForm(null);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the purchase.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (purchase: Purchase) => {
    if (!window.confirm(`Delete ${purchase.documentNo} from ${purchase.supplierName}?`)) return;
    try {
      await api(`/api/purchases/${purchase.id}`, sendJson('DELETE'));
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the purchase.'));
    }
  };

  return (
    <>
      <ItcMatchCard canWrite={canWrite} />

      <Card title="Purchase register">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <MonthRange from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
          <div className="flex gap-2">
            <a href={`/api/purchases/csv?from=${from}&to=${to}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
            {canWrite && (
              <button type="button" onClick={() => setForm(blank())} className={primaryButton}>
                <Plus className="w-3.5 h-3.5" />
                Record purchase
              </button>
            )}
          </div>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-3">
            <Stat label="Taxable value" value={formatInr(data.totals.taxableInr)} />
            <Stat label="GST paid" value={formatInr(data.totals.taxInr)} />
            <Stat label="Carats bought" value={`${data.totals.carats.toFixed(3)} ct`} />
          </div>
        )}
      </Card>

      {form && (
        <Card title={form.id ? `Edit ${form.documentNo}` : 'Record a purchase'}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <SelectField label="Type" value={form.kind} options={[['local', 'Local purchase (GST invoice)'], ['import', 'Import (Bill of Entry)']]} onChange={(value) => set('kind', value as Form['kind'])} />
            <Field label="Supplier" value={form.supplierName} required onChange={(value) => set('supplierName', value)} />
            {form.kind === 'local' ? (
              <Field label="Supplier GSTIN" value={form.supplierGstin} placeholder="Blank if unregistered" onChange={(value) => set('supplierGstin', value.toUpperCase())} />
            ) : (
              <Field label="Supplier country" value={form.supplierCountry} onChange={(value) => set('supplierCountry', value)} />
            )}
            <Field label={form.kind === 'import' ? 'Bill of Entry no' : 'Supplier invoice no'} value={form.documentNo} required onChange={(value) => set('documentNo', value)} />
            <Field label="Date" type="date" value={form.documentDate} required onChange={(value) => set('documentDate', value)} />
            {form.kind === 'import' && <Field label="Port code" value={form.portCode} onChange={(value) => set('portCode', value)} />}
            <Field label="Taxable / assessable value (₹)" value={form.taxableInr} required onChange={(value) => set('taxableInr', value)} />
            <Field label="IGST (₹)" value={form.igstInr} onChange={(value) => set('igstInr', value)} />
            {form.kind === 'local' && <Field label="CGST (₹)" value={form.cgstInr} onChange={(value) => set('cgstInr', value)} />}
            {form.kind === 'local' && <Field label="SGST (₹)" value={form.sgstInr} onChange={(value) => set('sgstInr', value)} />}
            <Field label="Carats" value={form.carats} onChange={(value) => set('carats', value)} />
            <Field label="Parcel / lot ID" value={form.parcelId} onChange={(value) => set('parcelId', value)} />
            <div className="md:col-span-2">
              <Field label="Description" value={form.description} placeholder="Rough, 2-4 ct, Angola" onChange={(value) => set('description', value)} />
            </div>
            <Field label="Notes" value={form.notes} onChange={(value) => set('notes', value)} />
            <CheckField label="Related party (clause 23)" checked={form.relatedParty} onChange={(value) => set('relatedParty', value)} />
            <div className="md:col-span-4 flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save purchase'}
              </button>
              <button type="button" onClick={() => setForm(null)} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : data.purchases.length === 0 ? (
          <p className="text-sm text-slate-500">No purchases recorded between {from} and {to}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Supplier', 'Document', 'Taxable', 'GST', 'Carats', '']} />
              <tbody>
                {data.purchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td className={cell}>
                      <p className="font-semibold">{purchase.supplierName}</p>
                      <p className="text-xs text-slate-500">
                        {purchase.kind === 'import' ? `Import${purchase.supplierCountry ? ` · ${purchase.supplierCountry}` : ''}` : purchase.supplierGstin || 'Unregistered'}
                        {purchase.relatedParty ? ' · related party' : ''}
                      </p>
                    </td>
                    <td className={cell}>
                      {purchase.documentNo}
                      <p className="text-xs text-slate-500">{purchase.documentDate}</p>
                    </td>
                    <td className={`${cell} tabular-nums`}>{formatInr(purchase.taxableInr)}</td>
                    <td className={`${cell} tabular-nums`}>{formatInr(purchase.taxInr)}</td>
                    <td className={`${cell} tabular-nums`}>
                      {purchase.carats ? `${purchase.carats.toFixed(3)} ct` : '—'}
                      {purchase.parcelId && <p className="text-xs text-slate-500">{purchase.parcelId}</p>}
                    </td>
                    <td className={`${cell} text-right whitespace-nowrap`}>
                      {canWrite && (
                        <button type="button" onClick={() => setForm(fromPurchase(purchase))} className={secondaryButton}>
                          Edit
                        </button>
                      )}
                      {canManage && (
                        <button type="button" onClick={() => remove(purchase)} className={`${dangerButton} ml-2`}>
                          Delete
                        </button>
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
