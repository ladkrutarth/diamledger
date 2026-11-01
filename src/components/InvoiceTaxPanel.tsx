import React, { useEffect, useState } from 'react';
import {
  api,
  errorMessage,
  sendJson,
  type ExportScheme,
  type InvoiceTax,
  type ReviewStatus,
  type TaxDocumentKind,
} from '../api/client';
import { Field, Notice, dangerButton, inputClass, primaryButton, secondaryButton } from './ui';

const PAPERS: Array<{ kind: TaxDocumentKind; label: string }> = [
  { kind: 'shipping_bill', label: 'Shipping bill' },
  { kind: 'airway_bill', label: 'Airway bill' },
  { kind: 'lut', label: 'LUT' },
];

interface Props {
  invoiceId: string | null;
  canEdit: boolean;
  isCharteredAccountant: boolean;
}

export const InvoiceTaxPanel: React.FC<Props> = ({ invoiceId, canEdit, isCharteredAccountant }) => {
  const [tax, setTax] = useState<InvoiceTax | null>(null);
  const [scheme, setScheme] = useState<ExportScheme>('lut');
  const [shippingBillNo, setShippingBillNo] = useState('');
  const [shippingBillDate, setShippingBillDate] = useState('');
  const [igstUsd, setIgstUsd] = useState('');
  const [portCode, setPortCode] = useState('');
  const [sbInvoiceNumber, setSbInvoiceNumber] = useState('');
  const [sbValueUsd, setSbValueUsd] = useState('');
  const [irn, setIrn] = useState('');
  const [ackNo, setAckNo] = useState('');
  const [ackDate, setAckDate] = useState('');
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('accepted');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (id: string) =>
    api<InvoiceTax>(`/api/invoices/${id}/tax`)
      .then((result) => {
        setTax(result);
        setScheme(result.exportScheme);
        setShippingBillNo(result.shippingBillNo);
        setShippingBillDate(result.shippingBillDate);
        setIgstUsd(result.igstUsd ? String(result.igstUsd) : '');
        setPortCode(result.portCode);
        setSbInvoiceNumber(result.sbInvoiceNumber);
        setSbValueUsd(result.sbValueUsd === null ? '' : String(result.sbValueUsd));
        setIrn(result.einvoice?.irn ?? '');
        setAckNo(result.einvoice?.ackNo ?? '');
        setAckDate(result.einvoice?.ackDate ?? '');
        setReviewStatus(result.review?.status ?? 'accepted');
        setComment(result.review?.comment ?? '');
        setError('');
      })
      .catch((err) => setError(errorMessage(err, 'Could not load the tax details.')));

  useEffect(() => {
    setTax(null);
    setMessage('');
    if (invoiceId) load(invoiceId);
  }, [invoiceId]);

  if (!invoiceId) {
    return (
      <div className="p-4">
        <Notice>Save the invoice first, then attach the shipping bill, airway bill, and LUT.</Notice>
      </div>
    );
  }

  const locked = Boolean(tax?.monthClosed);
  const editable = canEdit && !locked;

  const saveTax = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(
        `/api/invoices/${invoiceId}/tax`,
        sendJson('PUT', {
          exportScheme: scheme,
          shippingBillNo,
          shippingBillDate,
          igstUsd: scheme === 'igst' ? Number(igstUsd || 0) : 0,
          portCode,
          sbInvoiceNumber,
          sbValueUsd: sbValueUsd.trim() === '' ? null : Number(sbValueUsd),
        }),
      );
      setMessage('Shipping bill details saved.');
      await load(invoiceId);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the shipping bill details.'));
    } finally {
      setBusy(false);
    }
  };

  const saveEinvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/api/invoices/${invoiceId}/einvoice`, sendJson('PUT', { irn, ackNo, ackDate }));
      setMessage('IRN recorded.');
      await load(invoiceId);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the IRN.'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (kind: TaxDocumentKind, file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const dataBase64 = await fileToBase64(file);
      await api(
        `/api/invoices/${invoiceId}/documents`,
        sendJson('POST', { kind, fileName: file.name, contentType: file.type, dataBase64 }),
      );
      setMessage(`${file.name} attached.`);
      await load(invoiceId);
    } catch (err) {
      setError(errorMessage(err, 'Could not attach that file.'));
    } finally {
      setBusy(false);
    }
  };

  const removeDocument = async (docId: string) => {
    setError('');
    try {
      await api(`/api/invoices/${invoiceId}/documents/${docId}`, sendJson('DELETE'));
      await load(invoiceId);
    } catch (err) {
      setError(errorMessage(err, 'Could not remove that file.'));
    }
  };

  const saveReview = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(`/api/invoices/${invoiceId}/review`, sendJson('PUT', { status: reviewStatus, comment }));
      setMessage(reviewStatus === 'query' ? 'Query sent to the team.' : 'Invoice marked accepted.');
      await load(invoiceId);
    } catch (err) {
      setError(errorMessage(err, 'Could not save the review.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-sm">
      {locked && (
        <Notice>
          The books for {tax?.month} are closed. Shipping papers and the invoice stay as they were when the chartered accountant signed off.
        </Notice>
      )}
      {tax?.review && (
        <Notice tone={tax.review.status === 'query' ? 'error' : 'success'}>
          Chartered accountant: {tax.review.status === 'query' ? 'Query' : 'Accepted'}
          {tax.review.comment ? ` — ${tax.review.comment}` : ''}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}

      <form onSubmit={saveTax} className="space-y-3 rounded-lg border border-slate-200 p-3">
        <fieldset disabled={!editable} className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-700">Export scheme</h3>
        <label className="block text-[11px] font-semibold text-slate-600">
          How this export is taxed
          <select
            value={scheme}
            disabled={!editable}
            onChange={(event) => setScheme(event.target.value as ExportScheme)}
            className={`${inputClass} mt-1`}
          >
            <option value="lut">LUT — export without payment of IGST</option>
            <option value="igst">IGST paid</option>
          </select>
        </label>
        <Field label="Shipping bill number" value={shippingBillNo} onChange={setShippingBillNo} />
        <Field label="Shipping bill date" type="date" value={shippingBillDate} onChange={setShippingBillDate} />
        <Field label="Port code (6 characters, e.g. INBOM4)" value={portCode} onChange={(value) => setPortCode(value.toUpperCase())} />
        <Field label="Invoice number as printed on the shipping bill" value={sbInvoiceNumber} onChange={setSbInvoiceNumber} />
        <Field label="FOB value on the shipping bill (USD)" type="number" value={sbValueUsd} onChange={setSbValueUsd} />
        {scheme === 'igst' && <Field label="IGST amount (USD)" type="number" value={igstUsd} onChange={setIgstUsd} />}
        </fieldset>
        {editable ? (
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Saving...' : 'Save tax details'}
          </button>
        ) : (
          <p className="text-xs text-slate-500">These details are read-only on this account.</p>
        )}
      </form>

      <form onSubmit={saveEinvoice} className="space-y-3 rounded-lg border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-700">e-invoice</h3>
          <a href={`/api/invoices/${invoiceId}/einvoice.json`} className="text-xs font-semibold text-slate-900 underline">
            Download portal JSON
          </a>
        </div>
        <p className="text-xs text-slate-500">
          Upload the JSON on the e-invoice portal (or through your GSP), then record the IRN it returns. The app does not call the portal
          itself.
        </p>
        <fieldset disabled={!editable} className="space-y-3">
          <Field label="IRN (64 characters)" value={irn} onChange={setIrn} />
          <Field label="Acknowledgement number" value={ackNo} onChange={setAckNo} />
          <Field label="Acknowledgement date" type="date" value={ackDate} onChange={setAckDate} />
        </fieldset>
        {editable && (
          <button type="submit" disabled={busy || !irn.trim()} className={secondaryButton}>
            Save IRN
          </button>
        )}
      </form>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-700">Shipping papers</h3>
        {PAPERS.map((paper) => {
          const existing = tax?.documents.find((document) => document.kind === paper.kind);
          return (
            <div key={paper.kind} className="rounded-lg border border-slate-200 p-3">
              <p className="font-semibold text-slate-900">{paper.label}</p>
              {existing ? (
                <p className="text-xs text-slate-500 mt-1">
                  <a className="font-semibold text-slate-900 underline" href={`/api/invoices/${invoiceId}/documents/${existing.id}`}>
                    {existing.fileName}
                  </a>
                  {' · '}
                  {Math.ceil(existing.byteSize / 1024)} KB
                </p>
              ) : (
                <p className="text-xs text-slate-500 mt-1">No file attached.</p>
              )}
              {editable && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`Upload ${paper.label}`}
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      upload(paper.kind, file);
                    }}
                    className="text-xs"
                  />
                  {existing && (
                    <button type="button" onClick={() => removeDocument(existing.id)} className={dangerButton}>
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isCharteredAccountant && (
        <form onSubmit={saveReview} className="space-y-3 rounded-lg border border-slate-200 p-3">
          <h3 className="text-xs font-semibold text-slate-700">Review</h3>
          <label className="block text-[11px] font-semibold text-slate-600">
            Mark
            <select
              value={reviewStatus}
              onChange={(event) => setReviewStatus(event.target.value as ReviewStatus)}
              className={`${inputClass} mt-1`}
            >
              <option value="accepted">Accepted</option>
              <option value="query">Query</option>
            </select>
          </label>
          <label className="block text-[11px] font-semibold text-slate-600">
            Note for the team
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={3}
              className={`${inputClass} mt-1`}
            />
          </label>
          <button type="submit" disabled={busy} className={secondaryButton}>
            {busy ? 'Saving...' : 'Save review'}
          </button>
        </form>
      )}
    </div>
  );
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
