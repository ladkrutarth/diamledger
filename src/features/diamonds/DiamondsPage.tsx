import React, { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, Plus, Printer } from 'lucide-react';
import {
  api,
  errorMessage,
  sendJson,
  type CertificateReport,
  type KpReport,
  type Parcel,
  type ParcelRegister,
  type StockRegisterReport,
} from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { MonthRange, financialYearStart } from '../tax/RefundDesk';
import { Badge, InvoiceLink, SelectField, Stat, TableHead, YearField, cell, financialYearOf, formatInr, thisMonth, useReport } from '../../components/shared';
import { Card, Field, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

type Tab = 'parcels' | 'stock' | 'certificates' | 'kp';

const carats = (value: number) => `${value.toFixed(3)} ct`;

const STATUS: Record<Parcel['status'], { tone: 'green' | 'amber' | 'red' | 'slate'; label: string }> = {
  in_stock: { tone: 'green', label: 'In stock' },
  partial: { tone: 'amber', label: 'Part sold' },
  sold: { tone: 'slate', label: 'Sold out' },
  over: { tone: 'red', label: 'Over-invoiced' },
};

type ParcelForm = {
  id: string | null;
  parcelId: string;
  description: string;
  receivedOn: string;
  source: string;
  piecesIn: string;
  caratsIn: string;
  notes: string;
  stockKind: 'rough' | 'polished';
  costInr: string;
  madeFrom: string;
  roughCaratsUsed: string;
};

const blankForm = (): ParcelForm => ({
  id: null,
  parcelId: '',
  description: '',
  receivedOn: new Date().toISOString().slice(0, 10),
  source: '',
  piecesIn: '',
  caratsIn: '',
  notes: '',
  stockKind: 'polished',
  costInr: '',
  madeFrom: '',
  roughCaratsUsed: '',
});

const ParcelsTab: React.FC<{ canWrite: boolean; isAdmin: boolean }> = ({ canWrite, isAdmin }) => {
  const [register, setRegister] = useState<ParcelRegister | null>(null);
  const [form, setForm] = useState<ParcelForm | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setRegister(await api<ParcelRegister>('/api/parcels')), []);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err, 'Could not load the parcel register.')));
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const body = {
        ...form,
        piecesIn: form.piecesIn === '' ? 0 : Number(form.piecesIn),
        caratsIn: Number(form.caratsIn),
        costInr: form.costInr === '' ? null : Number(form.costInr),
        madeFrom: form.stockKind === 'polished' ? form.madeFrom : '',
        roughCaratsUsed: form.madeFrom && form.stockKind === 'polished' ? Number(form.roughCaratsUsed) : null,
      };
      await api(form.id ? `/api/parcels/${form.id}` : '/api/parcels', sendJson(form.id ? 'PUT' : 'POST', body));
      setForm(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the parcel.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (parcel: Parcel) => {
    if (!window.confirm(`Delete parcel ${parcel.parcelId} from the register? Invoices are not changed.`)) return;
    try {
      await api(`/api/parcels/${parcel.id}`, sendJson('DELETE'));
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the parcel.'));
    }
  };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          {register ? (
            <div className="grid gap-6 grid-cols-2 sm:grid-cols-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Received</p>
                <p className="text-lg font-semibold tabular-nums">{carats(register.totals.caratsIn)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Invoiced</p>
                <p className="text-lg font-semibold tabular-nums">{carats(register.totals.caratsOut)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">In stock</p>
                <p className="text-lg font-semibold tabular-nums">{carats(register.totals.balanceCarats)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Over-invoiced parcels</p>
                <p className={`text-lg font-semibold ${register.totals.overInvoiced ? 'text-red-700' : ''}`}>{register.totals.overInvoiced}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading...</p>
          )}
          <div className="flex gap-2">
            <a href="/api/parcels/csv" className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
            {canWrite && (
              <button type="button" onClick={() => setForm(blankForm())} className={primaryButton}>
                <Plus className="w-3.5 h-3.5" />
                Receive parcel
              </button>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Record each parcel or lot when it comes in. Carats out are read from issued invoices whose line items carry the same parcel ID,
          so the balance updates by itself. Draft invoices are shown separately and not counted.
        </p>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      {form && (
        <Card title={form.id ? `Edit parcel ${form.parcelId}` : 'Receive a parcel'}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="Parcel / lot ID" value={form.parcelId} required onChange={(value) => setForm({ ...form, parcelId: value })} />
            <Field label="Carats in" value={form.caratsIn} required onChange={(value) => setForm({ ...form, caratsIn: value })} />
            <Field label="Pieces in" value={form.piecesIn} onChange={(value) => setForm({ ...form, piecesIn: value })} />
            <Field label="Received on" type="date" value={form.receivedOn} onChange={(value) => setForm({ ...form, receivedOn: value })} />
            <SelectField
              label="Type"
              value={form.stockKind}
              options={[['polished', 'Polished'], ['rough', 'Rough']]}
              onChange={(value) => setForm({ ...form, stockKind: value as ParcelForm['stockKind'] })}
            />
            <Field label="Cost (₹)" value={form.costInr} placeholder={form.madeFrom ? 'Blank: cost of rough used' : ''} onChange={(value) => setForm({ ...form, costInr: value })} />
            {form.stockKind === 'polished' && (
              <>
                <Field label="Cut from rough parcel" value={form.madeFrom} placeholder="Blank if bought polished" onChange={(value) => setForm({ ...form, madeFrom: value })} />
                {form.madeFrom && (
                  <Field label="Rough carats used" value={form.roughCaratsUsed} required onChange={(value) => setForm({ ...form, roughCaratsUsed: value })} />
                )}
              </>
            )}
            <div className="md:col-span-2">
              <Field label="Description" value={form.description} placeholder="Round brilliant, VS1-VS2, F-G" onChange={(value) => setForm({ ...form, description: value })} />
            </div>
            <Field label="Bought from / source" value={form.source} onChange={(value) => setForm({ ...form, source: value })} />
            <Field label="Notes" value={form.notes} onChange={(value) => setForm({ ...form, notes: value })} />
            <div className="md:col-span-4 flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save parcel'}
              </button>
              <button type="button" onClick={() => setForm(null)} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        {!register ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : register.parcels.length === 0 ? (
          <p className="text-sm text-slate-500">No parcels yet. Use "Receive parcel" to add the first one.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Parcel', 'Received', 'In', 'Invoiced', 'Balance', 'Status', '']} />
              <tbody>
                {register.parcels.map((parcel) => (
                  <tr key={parcel.id}>
                    <td className={cell}>
                      <p className="font-semibold">
                        {parcel.parcelId} {parcel.stockKind === 'rough' && <Badge tone="slate">Rough</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">{parcel.description}</p>
                      {parcel.madeFrom && <p className="text-xs text-slate-500">Cut from {parcel.madeFrom} ({carats(parcel.roughCaratsUsed ?? 0)} rough)</p>}
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>
                      {parcel.receivedOn ?? '—'}
                      {parcel.source && <p className="text-xs text-slate-500">{parcel.source}</p>}
                    </td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>
                      {carats(parcel.caratsIn)}
                      {parcel.piecesIn > 0 && <p className="text-xs text-slate-500">{parcel.piecesIn} pcs</p>}
                    </td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>
                      {carats(parcel.caratsOut)}
                      {parcel.invoices.length > 0 && <p className="text-xs text-slate-500">{parcel.invoices.join(', ')}</p>}
                      {parcel.draftCarats > 0 && <p className="text-xs text-amber-800">+{carats(parcel.draftCarats)} on drafts</p>}
                      {parcel.consumedCarats > 0 && <p className="text-xs text-slate-500">{carats(parcel.consumedCarats)} sent for cutting</p>}
                    </td>
                    <td className={`${cell} tabular-nums font-semibold whitespace-nowrap ${parcel.balanceCarats < 0 ? 'text-red-700' : ''}`}>
                      {carats(parcel.balanceCarats)}
                    </td>
                    <td className={cell}>
                      <Badge tone={STATUS[parcel.status].tone}>{STATUS[parcel.status].label}</Badge>
                    </td>
                    <td className={`${cell} text-right whitespace-nowrap`}>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              id: parcel.id,
                              parcelId: parcel.parcelId,
                              description: parcel.description,
                              receivedOn: parcel.receivedOn ?? '',
                              source: parcel.source,
                              piecesIn: String(parcel.piecesIn || ''),
                              caratsIn: String(parcel.caratsIn),
                              notes: parcel.notes,
                              stockKind: parcel.stockKind,
                              costInr: parcel.costInr === null ? '' : String(parcel.costInr),
                              madeFrom: parcel.madeFrom,
                              roughCaratsUsed: parcel.roughCaratsUsed === null ? '' : String(parcel.roughCaratsUsed),
                            })
                          }
                          className={secondaryButton}
                        >
                          Edit
                        </button>
                      )}
                      {isAdmin && (
                        <button type="button" onClick={() => remove(parcel)} className={`${dangerButton} ml-2`}>
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

      {register && register.unregistered.length > 0 && (
        <Card title="Invoiced parcels not in the register">
          <p className="text-sm text-slate-600 mb-2">
            These parcel IDs appear on issued invoices but were never received into stock. Add them, or correct the parcel ID on the invoice.
          </p>
          <ul className="text-sm space-y-1">
            {register.unregistered.map((entry) => (
              <li key={entry.parcelId}>
                <span className="font-semibold">{entry.parcelId}</span> · {carats(entry.carats)} · {entry.invoices.join(', ')}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
};

const StockTab: React.FC = () => {
  const [year, setYear] = useState(financialYearOf());
  const { data, error } = useReport<StockRegisterReport>(`/api/stock/register?year=${year}`, 'Could not load the stock register.');
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-40">
            <YearField value={year} onChange={setYear} />
          </div>
          <a href={`/api/stock/register/csv?year=${year}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            CSV
          </a>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-2 sm:grid-cols-4">
            <Stat label="Rough closing" value={carats(data.rough.closing)} />
            <Stat label="Polished closing" value={carats(data.polished.closing)} />
            <Stat label="Closing stock at cost" value={formatInr(data.rough.closingValueInr + data.polished.closingValueInr)} />
            <Stat label="Yield, rough to polished" value={data.yieldPercent === null ? '—' : `${data.yieldPercent}%`} />
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Opening stock, receipts, rough sent for cutting, sales, and closing stock for the year, by parcel and in total. This is the
          quantitative detail the tax auditor reports in Form 3CD clause 35. Closing value is at cost; a polished parcel without its own cost
          takes the cost of the rough it was cut from.
        </p>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {data && (data.negativeParcels.length > 0 || data.soldWithoutParcel.rough + data.soldWithoutParcel.polished > 0) && (
        <Notice tone="error">
          {data.negativeParcels.length > 0 && `More sold or cut than received in ${data.negativeParcels.join(', ')}. `}
          {data.soldWithoutParcel.rough + data.soldWithoutParcel.polished > 0 &&
            `${carats(data.soldWithoutParcel.rough + data.soldWithoutParcel.polished)} invoiced this year without a parcel ID, so it is not in the register.`}
        </Notice>
      )}
      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : data.parcels.length === 0 ? (
          <p className="text-sm text-slate-500">No stock movement in {year}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Parcel', 'Opening', 'In', 'To cutting', 'Sold', 'Closing', 'Value']} />
              <tbody>
                {data.parcels.map((parcel) => (
                  <tr key={parcel.parcelId}>
                    <td className={cell}>
                      <p className="font-semibold">
                        {parcel.parcelId} {parcel.stockKind === 'rough' && <Badge tone="slate">Rough</Badge>}
                      </p>
                      {parcel.madeFrom && <p className="text-xs text-slate-500">Cut from {parcel.madeFrom}</p>}
                    </td>
                    <td className={`${cell} tabular-nums`}>{carats(parcel.opening)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(parcel.received)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(parcel.consumed)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(parcel.sold)}</td>
                    <td className={`${cell} tabular-nums font-semibold ${parcel.negative ? 'text-red-700' : ''}`}>{carats(parcel.closing)}</td>
                    <td className={`${cell} tabular-nums`}>{parcel.closingValueInr === null ? '—' : formatInr(parcel.closingValueInr)}</td>
                  </tr>
                ))}
                {(['rough', 'polished'] as const).map((kind) => (
                  <tr key={kind} className="bg-slate-50 font-semibold">
                    <td className={`${cell} capitalize`}>Total {kind}</td>
                    <td className={`${cell} tabular-nums`}>{carats(data[kind].opening)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(data[kind].purchased + data[kind].produced)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(data[kind].consumed)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(data[kind].sold)}</td>
                    <td className={`${cell} tabular-nums`}>{carats(data[kind].closing)}</td>
                    <td className={`${cell} tabular-nums`}>{formatInr(data[kind].closingValueInr)}</td>
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

function useRangeReport<T>(path: string, from: string, to: string) {
  const [report, setReport] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setReport(null);
    api<T>(`${path}?from=${from}&to=${to}`)
      .then((result) => {
        if (!current) return;
        setReport(result);
        setError('');
      })
      .catch((err) => current && setError(errorMessage(err, 'Could not load the report.')));
    return () => {
      current = false;
    };
  }, [path, from, to]);
  return { report, error };
}

const CertificatesTab: React.FC<{ from: string; to: string; onOpen: (id: string) => void }> = ({ from, to, onOpen }) => {
  const { report, error } = useRangeReport<CertificateReport>('/api/tax/certificates', from, to);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const rows = report ? (onlyIssues ? report.rows.filter((row) => row.issues.length) : report.rows) : [];
  return (
    <>
      <Card>
        {report && (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Polished lines</p>
              <p className="text-lg font-semibold">{report.totals.lines}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">With a certificate</p>
              <p className="text-lg font-semibold">{report.totals.certified}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Used twice</p>
              <p className={`text-lg font-semibold ${report.totals.duplicates ? 'text-red-700' : ''}`}>{report.totals.duplicates}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">To look at</p>
              <p className={`text-lg font-semibold ${report.totals.warnings ? 'text-amber-800' : ''}`}>{report.totals.warnings}</p>
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Checks the grading report numbers on issued invoices: the same certificate used on two lines, one certificate for several
          stones, and single stones of 0.30 ct or more without one. "Verify" opens the lab's own report check (GIA and IGI) so you can
          compare carats, colour, and clarity with the invoice line. The labs do not offer an open lookup service, so that comparison is
          done by eye.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyIssues} onChange={() => setOnlyIssues(!onlyIssues)} />
          Show only lines with something to check
        </label>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {!report ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing to show for {from} to {to}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Stone', 'Certificate', 'Checks']} />
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.invoiceId}-${row.line}`}>
                    <td className={cell}>
                      <InvoiceLink id={row.invoiceId} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
                      <p className="text-xs text-slate-500">Line {row.line}</p>
                    </td>
                    <td className={cell}>
                      <p>{row.description}</p>
                      <p className="text-xs text-slate-500">
                        {[`${row.pieces} pcs`, carats(row.carats), row.shape, row.colorClarity].filter(Boolean).join(' · ')}
                      </p>
                    </td>
                    <td className={`${cell} whitespace-nowrap`}>
                      {row.certificateNo ? (
                        <>
                          <p className="font-semibold">
                            {row.lab && <span className="text-slate-500">{row.lab} </span>}
                            {row.certificateNo}
                          </p>
                          {row.verifyUrl && (
                            <a href={row.verifyUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline">
                              Verify <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={cell}>
                      {row.issues.length === 0 ? (
                        <Badge tone="green">OK</Badge>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.issues.map((issue) => (
                            <li key={issue.text} className={`text-xs ${issue.tone === 'red' ? 'text-red-700' : 'text-amber-800'}`}>
                              {issue.text}
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
        )}
      </Card>
    </>
  );
};

const KpTab: React.FC<{ from: string; to: string; onOpen: (id: string) => void }> = ({ from, to, onOpen }) => {
  const { report, error } = useRangeReport<KpReport>('/api/tax/kp-register', from, to);
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          {report ? (
            <div className="grid gap-6 grid-cols-2 sm:grid-cols-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Shipments</p>
                <p className="text-lg font-semibold">{report.totals.shipments}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">With KP certificate</p>
                <p className="text-lg font-semibold">{report.totals.withKpc}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Rough carats</p>
                <p className="text-lg font-semibold tabular-nums">{carats(report.totals.roughCarats)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Need attention</p>
                <p className={`text-lg font-semibold ${report.totals.issues ? 'text-red-700' : ''}`}>{report.totals.issues}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading...</p>
          )}
          <div className="flex gap-2 print:hidden">
            <button type="button" onClick={() => window.print()} className={secondaryButton}>
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
            <a href={`/api/tax/kp-register/csv?from=${from}&to=${to}`} className={secondaryButton}>
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Kimberley Process certificate numbers per shipment, for audits. Rough and unsorted diamonds (HS 7102.10, 7102.21, 7102.31) must
          travel with a KP certificate; a shipment of rough without one, or two shipments sharing a certificate, is flagged.
        </p>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {!report ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : report.rows.length === 0 ? (
          <p className="text-sm text-slate-500">No issued invoices between {from} and {to}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Invoice', 'Destination', 'KP certificate', 'HS codes', 'Carats', 'Value', 'Checks']} />
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.invoiceId}>
                    <td className={cell}>
                      <InvoiceLink id={row.invoiceId} number={row.invoiceNumber} date={row.invoiceDate} onOpen={onOpen} />
                      <p className="text-xs text-slate-500">{row.buyerName}</p>
                    </td>
                    <td className={cell}>{row.destinationCountry || '—'}</td>
                    <td className={`${cell} font-semibold`}>{row.kpcNumber || '—'}</td>
                    <td className={`${cell} text-xs`}>{row.hsCodes.join(', ')}</td>
                    <td className={`${cell} tabular-nums whitespace-nowrap`}>
                      {carats(row.carats)}
                      {row.roughCarats > 0 && <p className="text-xs text-slate-500">{carats(row.roughCarats)} rough</p>}
                    </td>
                    <td className={`${cell} tabular-nums`}>{formatUsd(row.valueUsd)}</td>
                    <td className={cell}>
                      {row.issues.length === 0 ? (
                        <Badge tone="green">OK</Badge>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.issues.map((issue) => (
                            <li key={issue} className="text-xs text-red-700">
                              {issue}
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
        )}
      </Card>
    </>
  );
};

export const DiamondsPage: React.FC<{ canWrite: boolean; isAdmin: boolean; canUseTaxDesk: boolean; onOpen: (id: string) => void }> = ({
  canWrite,
  isAdmin,
  canUseTaxDesk,
  onOpen,
}) => {
  const [tab, setTab] = useState<Tab>('parcels');
  const [from, setFrom] = useState(financialYearStart());
  const [to, setTo] = useState(thisMonth());
  const tabs: Array<[Tab, string]> = [
    ['parcels', 'Stock and parcels'],
    ['stock', 'Stock register'],
    ...(canUseTaxDesk
      ? ([
          ['certificates', 'Certificate check'],
          ['kp', 'Kimberley Process register'],
        ] as Array<[Tab, string]>)
      : []),
  ];
  return (
    <Page
      title="Diamonds"
      description="Parcels in and out of stock, a check on the grading certificates you invoice, and the Kimberley Process register."
    >
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div className="flex flex-wrap gap-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${
                tab === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== 'parcels' && tab !== 'stock' && (
          <MonthRange
            from={from}
            to={to}
            onChange={(nextFrom, nextTo) => {
              setFrom(nextFrom);
              setTo(nextTo);
            }}
          />
        )}
      </div>
      {tab === 'parcels' && <ParcelsTab canWrite={canWrite} isAdmin={isAdmin} />}
      {tab === 'stock' && <StockTab />}
      {tab === 'certificates' && canUseTaxDesk && <CertificatesTab from={from} to={to} onOpen={onOpen} />}
      {tab === 'kp' && canUseTaxDesk && <KpTab from={from} to={to} onOpen={onOpen} />}
    </Page>
  );
};
