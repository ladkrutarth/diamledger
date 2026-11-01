/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FileSpreadsheet,
  Sparkles,
  Layers,
  Send,
  ShieldCheck,
  Download,
  Gem,
  Wallet,
  Lock,
  Bot,
  LayoutDashboard,
  ScrollText,
  Bell,
  Contact,
  Building2,
  Users,
  CircleUser,
} from 'lucide-react';
import { InvoiceState } from './types/invoice';
import { A1005InvoicePreview } from './components/A1005InvoicePreview';
import { DataEntryPanel } from './components/DataEntryPanel';
import { AiManifestParser } from './components/AiManifestParser';
import { AssistantPanel } from './components/AssistantPanel';
import { ErpSyncPanel } from './components/ErpSyncPanel';
import { EmailDispatchPanel } from './components/EmailDispatchPanel';
import { exportElementToPdf } from './utils/pdfGenerator';
import { LoginPage } from './components/LoginPage';
import { PaymentsPanel } from './components/PaymentsPanel';
import { StatusBadge } from './components/StatusBadge';
import { InvoicesPage } from './components/pages/InvoicesPage';
import { DashboardPage } from './components/pages/DashboardPage';
import { RemindersPage } from './components/pages/RemindersPage';
import { BuyersPage } from './components/pages/BuyersPage';
import { CompanyPage } from './components/pages/CompanyPage';
import { TeamPage } from './components/pages/TeamPage';
import { AccountPage } from './components/pages/AccountPage';
import {
  api,
  errorMessage,
  sendJson,
  type AuthUser,
  type Buyer,
  type Company,
  type InvoiceRecord,
  type InvoiceStatus,
  type InvoiceSummary,
} from './api/client';
import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from './brand';
import { applyBuyer, buildNewInvoice, buyerFromConsignee, duplicateInvoice } from './utils/invoiceDefaults';

type View = 'workspace' | 'dashboard' | 'invoices' | 'reminders' | 'buyers' | 'company' | 'team' | 'account';
type Module = 'editor' | 'payments' | 'erp' | 'email';

function readResetToken(): string | null {
  return new URLSearchParams(window.location.search).get('reset');
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);
  const [view, setView] = useState<View>('dashboard');
  const [company, setCompany] = useState<Company | null>(null);
  const [invoice, setInvoice] = useState<InvoiceState>(() => buildNewInvoice(null));
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceStatus>('draft');
  const [savedInvoices, setSavedInvoices] = useState<InvoiceSummary[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [activeModule, setActiveModule] = useState<Module>('editor');
  const [isAiParserOpen, setIsAiParserOpen] = useState<boolean>(false);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [invoiceListStatus, setInvoiceListStatus] = useState('');
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const isAdmin = user?.role === 'admin';
  const locked = status !== 'draft';

  useEffect(() => {
    if (resetToken) {
      setAuthReady(true);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    api<{ user: AuthUser }>('/api/auth/me', { signal: controller.signal })
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => {
        window.clearTimeout(timer);
        setAuthReady(true);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [resetToken]);

  const refreshInvoices = useCallback(async () => {
    const result = await api<{ invoices: InvoiceSummary[] }>('/api/invoices');
    setSavedInvoices(result.invoices);
  }, []);

  const refreshBuyers = useCallback(async () => {
    const result = await api<{ buyers: Buyer[] }>('/api/buyers');
    setBuyers(result.buyers);
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshInvoices().catch(() => setSavedInvoices([]));
    refreshBuyers().catch(() => setBuyers([]));
    api<Company>('/api/company')
      .then((result) => {
        setCompany(result);
        if (!invoiceId) setInvoice(buildNewInvoice(result.profile));
      })
      .catch(() => setCompany(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refreshInvoices, refreshBuyers]);

  const loadRecord = (record: InvoiceRecord) => {
    setInvoice(record.invoice);
    setInvoiceId(record.id);
    setStatus(record.status);
  };

  const editInvoice = (next: InvoiceState | ((prev: InvoiceState) => InvoiceState)) => {
    if (locked) return;
    setInvoice(next);
  };

  const handleTopDownload = async () => {
    setIsDownloading(true);
    try {
      const number = invoice.shipment.invoiceNumber || 'DRAFT';
      await exportElementToPdf('a1005-printable-document', {
        filename: `COMMERCIAL_INVOICE_${number.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`,
        download: true,
      });
    } catch (err) {
      console.error('Error generating PDF:', err);
      window.print();
    } finally {
      setIsDownloading(false);
    }
  };

  const saveDraft = async (): Promise<InvoiceRecord> => {
    const path = invoiceId ? `/api/invoices/${invoiceId}` : '/api/invoices';
    const saved = await api<InvoiceRecord>(path, sendJson(invoiceId ? 'PUT' : 'POST', { invoice }));
    loadRecord(saved);
    return saved;
  };

  const handleSaveInvoice = async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const saved = await saveDraft();
      await refreshInvoices();
      setSaveMessage({ tone: 'ok', text: `Saved as ${saved.invoiceNumber}` });
    } catch (err) {
      setSaveMessage({ tone: 'error', text: errorMessage(err, 'Could not save invoice.') });
    } finally {
      setIsSaving(false);
    }
  };

  const changeStatus = async (next: 'issued' | 'cancelled') => {
    const question =
      next === 'issued'
        ? 'Issue this invoice? It will be locked and can no longer be edited.'
        : 'Cancel this invoice? A cancelled invoice cannot be reopened.';
    if (!window.confirm(question)) return;

    setIsSaving(true);
    setSaveMessage(null);
    try {
      const saved = status === 'draft' ? await saveDraft() : null;
      const id = saved?.id ?? invoiceId;
      const updated = await api<InvoiceRecord>(`/api/invoices/${id}/status`, sendJson('PATCH', { status: next }));
      loadRecord(updated);
      await refreshInvoices();
      setSaveMessage({ tone: 'ok', text: next === 'issued' ? `Issued ${updated.invoiceNumber}` : 'Invoice cancelled' });
    } catch (err) {
      setSaveMessage({ tone: 'error', text: errorMessage(err, 'Could not change the invoice status.') });
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenInvoice = async (id: string) => {
    if (!id) return;
    setSaveMessage(null);
    try {
      loadRecord(await api<InvoiceRecord>(`/api/invoices/${id}`));
      setView('workspace');
    } catch (err) {
      setSaveMessage({ tone: 'error', text: errorMessage(err, 'Could not open invoice.') });
    }
  };

  const startDraft = (next: InvoiceState, message: string | null) => {
    setInvoice(next);
    setInvoiceId(null);
    setStatus('draft');
    setActiveModule('editor');
    setSaveMessage(message ? { tone: 'ok', text: message } : null);
    setView('workspace');
  };

  const handleNewInvoice = () => startDraft(buildNewInvoice(company?.profile ?? null), null);

  const handleDuplicate = () =>
    startDraft(duplicateInvoice(invoice), 'Copied into a new draft. It gets a new number when you save.');

  const handlePickBuyer = (buyerId: string) => {
    const buyer = buyers.find((row) => row.id === buyerId);
    if (buyer) editInvoice((prev) => applyBuyer(prev, buyer.consignee));
  };

  const handleSaveBuyer = async () => {
    const consignee = buyerFromConsignee(invoice.consignee);
    const existing = buyers.find(
      (row) => row.name.trim().toLowerCase() === consignee.companyName.trim().toLowerCase(),
    );
    try {
      await api(
        existing ? `/api/buyers/${existing.id}` : '/api/buyers',
        sendJson(existing ? 'PUT' : 'POST', { consignee }),
      );
      await refreshBuyers();
      setSaveMessage({ tone: 'ok', text: `${existing ? 'Updated' : 'Saved'} buyer ${consignee.companyName}` });
    } catch (err) {
      setSaveMessage({ tone: 'error', text: errorMessage(err, 'Could not save the buyer.') });
    }
  };

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // The local session still ends if the server is unreachable.
    }
    setUser(null);
    setCompany(null);
    setInvoice(buildNewInvoice(null));
    setInvoiceId(null);
    setStatus('draft');
    setSavedInvoices([]);
    setBuyers([]);
    setSaveMessage(null);
    setView('workspace');
  };

  const finishReset = () => {
    setResetToken(null);
    window.history.replaceState(null, '', window.location.pathname);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-600 flex items-center justify-center text-sm">
        Checking session...
      </div>
    );
  }

  if (!user) {
    return <LoginPage onSuccess={setUser} resetToken={resetToken} onResetFinished={finishReset} />;
  }

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

    newItems = newItems.map((item, idx) => ({ ...item, srNo: idx + 1 }));

    editInvoice((prev) => ({
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

  const navGroups: Array<{ label: string; items: Array<[View, string, React.ReactNode]> }> = [
    {
      label: 'Track',
      items: [
        ['dashboard', 'Dashboard', <LayoutDashboard className="w-4 h-4" />],
        ['invoices', 'Invoices', <ScrollText className="w-4 h-4" />],
        ['reminders', 'Collections', <Bell className="w-4 h-4" />],
      ],
    },
    {
      label: 'Work',
      items: [
        ['workspace', 'Invoice editor', <FileSpreadsheet className="w-4 h-4" />],
        ['buyers', 'Buyers', <Contact className="w-4 h-4" />],
      ],
    },
    {
      label: 'Company',
      items: [
        ['company', 'Company', <Building2 className="w-4 h-4" />],
        ...(isAdmin ? ([['team', 'Team', <Users className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>) : []),
        ['account', 'Account', <CircleUser className="w-4 h-4" />],
      ],
    },
  ];
  const currentNav = navGroups.flatMap((group) => group.items).find(([key]) => key === view);

  const moduleTabs: Array<[Module, string, React.ReactNode]> = [
    ['editor', 'Details', <FileSpreadsheet className="w-3.5 h-3.5" />],
    ['payments', 'Payments', <Wallet className="w-3.5 h-3.5" />],
    ['erp', 'Accounts export', <Layers className="w-3.5 h-3.5" />],
    ['email', 'Email', <Send className="w-3.5 h-3.5" />],
  ];

  const canCancel = status === 'draft' ? Boolean(invoiceId) : status !== 'cancelled' && isAdmin;

  const navButton = (key: View, label: string, icon: React.ReactNode, compact = false) => (
    <button
      key={key}
      onClick={() => {
        if (key === 'invoices') setInvoiceListStatus('');
        setView(key);
      }}
      className={`flex items-center gap-2 rounded-lg text-left font-medium transition-colors ${
        compact ? 'px-2.5 py-1.5 text-xs whitespace-nowrap' : 'w-full px-2.5 py-2 text-sm'
      } ${view === key ? 'bg-white text-stone-950' : 'text-stone-300 hover:bg-white/10 hover:text-white'}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="flex h-screen w-screen bg-slate-100 text-stone-800 font-sans overflow-hidden">
      <aside className="hidden md:flex w-60 shrink-0 flex-col bg-stone-950 text-stone-200">
        <div className="px-4 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
              <Gem className="w-4 h-4 text-amber-200" />
            </div>
            <div className="leading-tight">
              <span className="block text-sm font-semibold tracking-tight text-white">{PRODUCT_NAME}</span>
              <span className="block text-[11px] text-stone-400">{PRODUCT_TAGLINE}</span>
            </div>
          </div>
          <p className="mt-4 text-xs font-medium text-stone-300 truncate" title={user.organizationName || COMPANY_NAME}>
            {user.organizationName || COMPANY_NAME}
          </p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-500">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(([key, label, icon]) => navButton(key, label, icon))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header className="flex items-center justify-between gap-4 px-4 md:px-6 py-3 bg-white border-b border-stone-200 shrink-0 z-20">
        <p className="md:hidden text-sm font-semibold text-stone-950">{PRODUCT_NAME}</p>
        <p className="hidden md:block text-xs text-stone-500">{currentNav?.[1]}</p>
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden xl:inline text-xs text-stone-500 max-w-[180px] truncate">{user.email}</span>
          <button
            onClick={() => setIsAssistantOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-lg"
          >
            <Bot className="w-3.5 h-3.5" />
            Assistant
          </button>
          <button onClick={handleLogout} className="px-2.5 py-1.5 text-xs font-semibold text-stone-600 hover:text-stone-950">
            Log out
          </button>
          {view === 'workspace' && (
            <>
              <button
                onClick={() => setIsAiParserOpen(true)}
                disabled={locked}
                className="hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-stone-700 hover:text-stone-950 disabled:opacity-40"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Read a manifest
              </button>
              <button
                onClick={handleSaveInvoice}
                disabled={isSaving || locked}
                className="px-3 py-1.5 text-xs font-semibold text-stone-900 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleTopDownload}
                disabled={isDownloading}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-stone-900 hover:bg-stone-800 rounded-lg disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isDownloading ? 'Preparing...' : 'Download PDF'}</span>
              </button>
            </>
          )}
        </div>
      </header>
      <nav className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 bg-stone-950">
        {navGroups.flatMap((group) => group.items).map(([key, label, icon]) => navButton(key, label, icon, true))}
      </nav>

      {view === 'dashboard' && (
        <DashboardPage
          key={dataVersion}
          onOpen={handleOpenInvoice}
          onFollowUp={() => setView('reminders')}
          onBrowse={(status) => {
            setInvoiceListStatus(status);
            setView('invoices');
          }}
        />
      )}
      {view === 'invoices' && (
        <InvoicesPage
          key={`${dataVersion}-${invoiceListStatus}`}
          isAdmin={isAdmin}
          initialStatus={invoiceListStatus}
          onOpen={handleOpenInvoice}
          onNew={handleNewInvoice}
        />
      )}
      {view === 'reminders' && <RemindersPage key={dataVersion} />}
      {view === 'buyers' && <BuyersPage />}
      {view === 'company' && (
        <CompanyPage
          isAdmin={isAdmin}
          onSaved={(saved) => {
            setCompany(saved);
            setUser({ ...user, organizationName: saved.name });
          }}
        />
      )}
      {view === 'team' && isAdmin && <TeamPage currentUserId={user.id} />}
      {view === 'account' && <AccountPage user={user} />}

      {view === 'workspace' && (
        <>
          <div className="bg-white text-stone-600 px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] border-b border-stone-200 shrink-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="flex items-center gap-1 font-semibold text-emerald-800">
                <ShieldCheck className="w-3.5 h-3.5" />
                Kimberley Process
              </span>
              <span>RCMC {invoice.exporter.rcmcNo || '—'}</span>
              <span>LUT {invoice.shipment.lutNumber || '—'}</span>
              <span>AD code {invoice.bank.adCode || '—'}</span>
            </div>

            <div className="flex items-center gap-2 font-medium text-stone-800">
              <span>{invoice.shipment.portOfLoading.split('(')[0].trim() || 'Loading port'}</span>
              <span className="text-stone-400">→</span>
              <span>{invoice.shipment.portOfDischarge.split('(')[0].trim() || 'Discharge port'}</span>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <aside className="w-full md:w-[48%] lg:w-[45%] xl:w-[43%] flex flex-col border-r border-slate-300 bg-white shadow-xs z-10 shrink-0">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-white">
                <label htmlFor="saved-invoices" className="text-[11px] font-semibold text-slate-600 shrink-0">
                  Invoice
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
                      {saved.invoiceNumber} · {saved.status}
                    </option>
                  ))}
                </select>
                <StatusBadge status={status} />
                <button
                  onClick={handleNewInvoice}
                  className="px-2 py-1 text-xs font-semibold rounded-md border border-slate-300 hover:bg-slate-50"
                >
                  New
                </button>
                <button
                  onClick={handleDuplicate}
                  className="px-2 py-1 text-xs font-semibold rounded-md border border-slate-300 hover:bg-slate-50"
                >
                  Duplicate
                </button>
              </div>

              <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50">
                <label htmlFor="buyer-picker" className="text-[11px] font-semibold text-slate-600 shrink-0">
                  Buyer
                </label>
                <select
                  id="buyer-picker"
                  value=""
                  disabled={locked || buyers.length === 0}
                  onChange={(event) => handlePickBuyer(event.target.value)}
                  className="flex-1 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-60"
                >
                  <option value="">
                    {buyers.length === 0 ? 'No saved buyers yet' : 'Fill consignee from a saved buyer...'}
                  </option>
                  {buyers.map((buyer) => (
                    <option key={buyer.id} value={buyer.id}>
                      {buyer.name}
                      {buyer.consignee.country ? ` (${buyer.consignee.country})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleSaveBuyer}
                  disabled={!invoice.consignee.companyName.trim()}
                  className="px-2 py-1 text-xs font-semibold rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50"
                >
                  Save buyer
                </button>
                {status === 'draft' && (
                  <button
                    onClick={() => changeStatus('issued')}
                    disabled={isSaving}
                    className="px-2 py-1 text-xs font-semibold rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Issue
                  </button>
                )}
                {canCancel && (
                  <button
                    onClick={() => changeStatus('cancelled')}
                    disabled={isSaving}
                    className="px-2 py-1 text-xs font-semibold rounded-md border border-red-200 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50"
                  >
                    Cancel invoice
                  </button>
                )}
              </div>

              {locked && (
                <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-amber-50 text-amber-900 border-b border-amber-200">
                  <Lock className="w-3 h-3" />
                  This invoice is {status} and locked. Use Duplicate to start a new draft from it.
                </p>
              )}
              {saveMessage && (
                <p
                  role={saveMessage.tone === 'error' ? 'alert' : 'status'}
                  className={`px-3 py-1 text-[11px] ${saveMessage.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}
                >
                  {saveMessage.text}
                </p>
              )}

              <div className="flex items-center justify-around border-b border-slate-200 bg-slate-50 text-xs font-semibold p-1">
                {moduleTabs.map(([key, label, icon]) => (
                  <button
                    key={key}
                    onClick={() => setActiveModule(key)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md transition-colors ${
                      activeModule === key ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-hidden">
                {activeModule === 'editor' && (
                  <fieldset disabled={locked} className="h-full min-w-0">
                    <DataEntryPanel
                      invoice={invoice}
                      onChange={editInvoice}
                      onOpenAiParser={() => setIsAiParserOpen(true)}
                    />
                  </fieldset>
                )}
                {activeModule === 'payments' && (
                  <PaymentsPanel
                    invoiceId={invoiceId}
                    status={status}
                    isAdmin={isAdmin}
                    onChanged={async () => {
                      if (invoiceId) {
                        const record = await api<InvoiceRecord>(`/api/invoices/${invoiceId}`);
                        setStatus(record.status);
                      }
                      await refreshInvoices();
                    }}
                  />
                )}
                {activeModule === 'erp' && <ErpSyncPanel invoice={invoice} />}
                {activeModule === 'email' && <EmailDispatchPanel invoice={invoice} />}
              </div>
            </aside>

            <main className="flex-1 overflow-hidden flex flex-col bg-slate-200/80">
              <A1005InvoicePreview invoice={invoice} onUpdateInvoice={editInvoice} />
            </main>
          </div>
        </>
      )}

      {isAiParserOpen && !locked && (
        <AiManifestParser
          onApplyParsedData={handleApplyAiData}
          onClose={() => setIsAiParserOpen(false)}
        />
      )}

      {isAssistantOpen && (
        <AssistantPanel
          userId={user.id}
          onClose={() => setIsAssistantOpen(false)}
          onOpenInvoice={(id) => {
            setIsAssistantOpen(false);
            handleOpenInvoice(id);
          }}
          onChanged={async () => {
            setDataVersion((version) => version + 1);
            if (invoiceId) {
              const record = await api<InvoiceRecord>(`/api/invoices/${invoiceId}`).catch(() => null);
              if (record) setStatus(record.status);
            }
            await refreshInvoices().catch(() => undefined);
          }}
        />
      )}
      </div>
    </div>
  );
}
