/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { 
  FileSpreadsheet, 
  Sparkles, 
  Layers, 
  Send, 
  ShieldCheck, 
  Download, 
  Printer, 
  Eye, 
  CheckCircle2, 
  Gem,
  Building,
  HelpCircle
} from 'lucide-react';
import { InvoiceState } from './types/invoice';
import { SURAT_TO_ANTWERP_PRESET } from './data/sampleInvoices';
import { A1005InvoicePreview } from './components/A1005InvoicePreview';
import { DataEntryPanel } from './components/DataEntryPanel';
import { AiManifestParser } from './components/AiManifestParser';
import { ErpSyncPanel } from './components/ErpSyncPanel';
import { EmailDispatchPanel } from './components/EmailDispatchPanel';
import { exportElementToPdf } from './utils/pdfGenerator';
import { LoginPage } from './components/LoginPage';
import { ApiError, api, type AuthUser, type InvoiceSummary } from './api/client';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceState>(SURAT_TO_ANTWERP_PRESET);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [savedInvoices, setSavedInvoices] = useState<InvoiceSummary[]>([]);
  const [activeModule, setActiveModule] = useState<'editor' | 'erp' | 'email'>('editor');
  const [isAiParserOpen, setIsAiParserOpen] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    api<{ user: AuthUser }>('/api/auth/me')
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setAuthReady(true));
  }, []);

  const refreshInvoices = async () => {
    const result = await api<{ invoices: InvoiceSummary[] }>('/api/invoices');
    setSavedInvoices(result.invoices);
  };

  useEffect(() => {
    if (!user) return;
    refreshInvoices().catch(() => setSavedInvoices([]));
  }, [user]);

  // Quick download from top bar
  const handleTopDownload = async () => {
    setIsDownloading(true);
    try {
      await exportElementToPdf('a1005-printable-document', {
        filename: `COMMERCIAL_INVOICE_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`,
        download: true,
      });
    } catch (err) {
      console.error('Error generating PDF:', err);
      window.print();
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSaveInvoice = async () => {
    setIsSaving(true);
    setSaveMessage('');
    try {
      const payload = { method: invoiceId ? 'PUT' : 'POST', body: JSON.stringify({ invoice }) };
      const path = invoiceId ? `/api/invoices/${invoiceId}` : '/api/invoices';
      const saved = await api<{ id: string }>(path, payload);
      setInvoiceId(saved.id);
      await refreshInvoices();
      setSaveMessage('Saved');
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : 'Could not save invoice.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenInvoice = async (id: string) => {
    if (!id) return;
    setSaveMessage('');
    try {
      const saved = await api<{ id: string; invoice: InvoiceState }>(`/api/invoices/${id}`);
      setInvoice(saved.invoice);
      setInvoiceId(saved.id);
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : 'Could not open invoice.');
    }
  };

  const handleNewInvoice = () => {
    setInvoice(SURAT_TO_ANTWERP_PRESET);
    setInvoiceId(null);
    setSaveMessage('');
  };

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // The local session still ends if the server is unreachable.
    }
    setUser(null);
    setInvoice(SURAT_TO_ANTWERP_PRESET);
    setInvoiceId(null);
    setSavedInvoices([]);
    setSaveMessage('');
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-600 flex items-center justify-center text-sm">
        Checking session...
      </div>
    );
  }

  if (!user) {
    return <LoginPage onSuccess={setUser} />;
  }

  // AI parsed data merge callback
  const handleApplyAiData = (
    data: { items: any[]; notes?: string; consigneeName?: string; portOfDestination?: string; kpcsNumber?: string },
    mode: 'replace' | 'append'
  ) => {
    let newItems = [...invoice.items];
    if (mode === 'replace') {
      newItems = data.items;
    } else {
      newItems = [...newItems, ...data.items];
    }

    // Re-index serial numbers
    newItems = newItems.map((item, idx) => ({ ...item, srNo: idx + 1 }));

    setInvoice((prev) => ({
      ...prev,
      items: newItems,
      consignee: {
        ...prev.consignee,
        companyName: data.consigneeName || prev.consignee.companyName,
      },
      shipment: {
        ...prev.shipment,
        portOfDischarge: data.portOfDestination || prev.shipment.portOfDischarge,
        kpcsNumber: data.kpcsNumber || prev.shipment.kpcsNumber,
      },
    }));
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-100 text-slate-800 font-sans overflow-hidden">
      {/* 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3 bg-white border-b border-slate-200 shrink-0 z-20">
        {/* Zone 1: Single Wordmark */}
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-white shadow-xs">
            <Gem className="w-4 h-4 text-sky-400" />
          </div>
          <span className="text-base font-bold tracking-tight text-slate-950 font-sans">
            DiamondX-A1005
          </span>
        </div>

        {/* Zone 2: Navigation Links (Single Line) */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-semibold text-slate-600">
          <button
            onClick={() => setActiveModule('editor')}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeModule === 'editor' ? 'text-slate-950 font-bold border-b-2 border-slate-900 pb-0.5' : 'hover:text-slate-900'
            }`}
          >
            Invoice Workspace
          </button>
          <button
            onClick={() => setIsAiParserOpen(true)}
            className="flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 text-indigo-600 hover:text-indigo-800 font-semibold"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Parcel Parser</span>
          </button>
          <button
            onClick={() => setActiveModule('erp')}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeModule === 'erp' ? 'text-slate-950 font-bold border-b-2 border-slate-900 pb-0.5' : 'hover:text-slate-900'
            }`}
          >
            Tally & SAP Sync
          </button>
          <button
            onClick={() => setActiveModule('email')}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              activeModule === 'email' ? 'text-slate-950 font-bold border-b-2 border-slate-900 pb-0.5' : 'hover:text-slate-900'
            }`}
          >
            SMTP Email Dispatch
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden lg:inline text-xs text-slate-500 max-w-[180px] truncate">{user.email}</span>
          <button
            onClick={handleLogout}
            className="px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:text-slate-950"
          >
            Log out
          </button>
          <button
            onClick={handleSaveInvoice}
            disabled={isSaving}
            className="px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleTopDownload}
            disabled={isDownloading}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-xs disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-sky-400" />
            <span>{isDownloading ? 'Generating...' : 'Export A4 PDF'}</span>
          </button>
        </div>
      </header>

      {/* Trust & Compliance Sub-Bar */}
      <div className="bg-slate-900 text-white px-6 py-1.5 flex flex-wrap items-center justify-between text-[11px] font-mono border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1 text-emerald-400 font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" />
            KPCS Conflict-Free Guaranteed
          </span>
          <span className="text-slate-400">|</span>
          <span className="text-slate-300">
            GJEPC RCMC: <strong className="text-white font-bold">{invoice.exporter.rcmcNo}</strong>
          </span>
          <span className="text-slate-400">|</span>
          <span className="text-slate-300">
            LUT ARN: <strong className="text-white font-bold">{invoice.shipment.lutNumber}</strong>
          </span>
          <span className="text-slate-400">|</span>
          <span className="text-slate-300">
            Bank AD Code: <strong className="text-sky-300 font-bold">{invoice.bank.adCode}</strong>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-slate-300">
            Port: <strong className="text-white">{invoice.shipment.portOfLoading.split('(')[0].trim()}</strong>
          </span>
          <span className="text-slate-400">→</span>
          <span className="text-emerald-400 font-bold">{invoice.shipment.portOfDischarge.split('(')[0].trim()}</span>
        </div>
      </div>

      {/* Main Split Layout: Left Workspace + Right A4 PDF Preview */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Workspace Panel */}
        <aside className="w-full md:w-[48%] lg:w-[45%] xl:w-[43%] flex flex-col border-r border-slate-300 bg-white shadow-xs z-10 shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white">
            <label htmlFor="saved-invoices" className="text-[11px] font-semibold text-slate-600 shrink-0">
              My invoices
            </label>
            <select
              id="saved-invoices"
              value={invoiceId ?? ''}
              onChange={(event) => handleOpenInvoice(event.target.value)}
              className="flex-1 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="">Unsaved draft</option>
              {savedInvoices.map((saved) => (
                <option key={saved.id} value={saved.id}>
                  {saved.invoiceNumber}
                </option>
              ))}
            </select>
            <button
              onClick={handleNewInvoice}
              className="px-2 py-1 text-xs font-semibold rounded-md border border-slate-300 hover:bg-slate-50"
            >
              New
            </button>
          </div>
          {saveMessage && (
            <p className={`px-3 py-1 text-[11px] ${saveMessage === 'Saved' ? 'text-emerald-700' : 'text-red-700'}`}>
              {saveMessage}
            </p>
          )}
          {/* Module Switcher Tabs */}
          <div className="flex items-center justify-around border-b border-slate-200 bg-slate-50 text-xs font-semibold p-1">
            <button
              onClick={() => setActiveModule('editor')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors ${
                activeModule === 'editor'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-blue-600" />
              <span>Data Input</span>
            </button>
            <button
              onClick={() => setActiveModule('erp')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors ${
                activeModule === 'erp'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-indigo-600" />
              <span>Tally / SAP Sync</span>
            </button>
            <button
              onClick={() => setActiveModule('email')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors ${
                activeModule === 'email'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Send className="w-3.5 h-3.5 text-emerald-600" />
              <span>SMTP Dispatch</span>
            </button>
          </div>

          {/* Module Content */}
          <div className="flex-1 overflow-hidden">
            {activeModule === 'editor' && (
              <DataEntryPanel
                invoice={invoice}
                onChange={setInvoice}
                onOpenAiParser={() => setIsAiParserOpen(true)}
              />
            )}
            {activeModule === 'erp' && <ErpSyncPanel invoice={invoice} />}
            {activeModule === 'email' && <EmailDispatchPanel invoice={invoice} />}
          </div>
        </aside>

        {/* Right Workspace: Live 100% Layout-Matched A4 PDF Invoice Preview */}
        <main className="flex-1 overflow-hidden flex flex-col bg-slate-200/80">
          <A1005InvoicePreview invoice={invoice} onUpdateInvoice={setInvoice} />
        </main>
      </div>

      {/* AI Parcel Manifest Parser Modal */}
      {isAiParserOpen && (
        <AiManifestParser
          onApplyParsedData={handleApplyAiData}
          onClose={() => setIsAiParserOpen(false)}
        />
      )}
    </div>
  );
}
