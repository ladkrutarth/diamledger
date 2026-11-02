/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileSpreadsheet,
  Layers,
  Send,
  Gem,
  Wallet,
  Bot,
  LayoutDashboard,
  ScrollText,
  Bell,
  Contact,
  Building2,
  Users,
  CircleUser,
  Landmark,
  History,
  Diamond,
  MessageSquare,
  Briefcase,
  CreditCard,
} from 'lucide-react';
import { InvoiceState } from './types/invoice';
import { A1005InvoicePreview } from './features/invoices/A1005InvoicePreview';
import { InvoiceEditor } from './features/invoices/editor/InvoiceEditor';
import { InvoiceToolbar } from './features/invoices/editor/InvoiceToolbar';
import { checkInvoice, invoiceTotals } from './features/invoices/editor/invoiceChecks';
import { MUMBAI_TO_NY_PRESET, SURAT_TO_ANTWERP_PRESET, SURAT_TO_DUBAI_PRESET } from './data/sampleInvoices';
import { AiManifestParser } from './features/invoices/AiManifestParser';
import { AssistantPanel } from './features/assistant/AssistantPanel';
import { ErpSyncPanel } from './features/invoices/ErpSyncPanel';
import { EmailDispatchPanel } from './features/invoices/EmailDispatchPanel';
import { exportElementToPdf } from './utils/pdfGenerator';
import { LoginPage } from './features/auth/LoginPage';
import { PaymentsPanel } from './features/invoices/PaymentsPanel';
import { InvoicesPage } from './features/invoices/InvoicesPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { RemindersPage } from './features/collections/RemindersPage';
import { BuyersPage } from './features/buyers/BuyersPage';
import { CompanyPage } from './features/company/CompanyPage';
import { TeamPage } from './features/company/TeamPage';
import { AccountPage } from './features/auth/AccountPage';
import { TaxPage } from './features/tax/TaxPage';
import { ActivityPage } from './features/company/ActivityPage';
import { DiamondsPage } from './features/diamonds/DiamondsPage';
import { PracticePage } from './features/accountant/PracticePage';
import { RequestsPage } from './features/accountant/RequestsPage';
import { BillingPage } from './features/billing/BillingPage';
import { BankTransfersAdmin } from './features/billing/BankTransfersAdmin';
import { InvoiceTaxPanel } from './features/invoices/InvoiceTaxPanel';
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
  type BillingSummary,
  type ShipmentCheck,
  type WorkspaceCompany,
  ROLE_LABEL,
} from './api/client';
import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from './brand';
import { applyBuyer, buildNewInvoice, buyerFromConsignee, duplicateInvoice } from './utils/invoiceDefaults';

type View =
  | 'workspace' | 'dashboard' | 'invoices' | 'reminders' | 'buyers' | 'company' | 'team' | 'account' | 'tax' | 'activity' | 'diamonds'
  | 'requests' | 'practice' | 'billing' | 'bank-transfers';
type Module = 'editor' | 'payments' | 'erp' | 'email' | 'tax';

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
  const [companies, setCompanies] = useState<WorkspaceCompany[]>([]);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  /** The invoice as last loaded or saved, to tell whether there are unsaved changes. */
  const [savedSnapshot, setSavedSnapshot] = useState('');
  /** After a failed attempt to issue, show "missing" messages on every field. */
  const [showAllChecks, setShowAllChecks] = useState(false);

  const refreshBilling = useCallback(() => {
    api<BillingSummary>('/api/billing')
      .then(setBilling)
      .catch(() => setBilling(null));
  }, []);

  const isAdmin = user?.role === 'admin';
  const isCharteredAccountant = user?.role === 'ca';
  const canWrite = Boolean(user && user.role !== 'ca');
  const canUseTaxDesk = user?.role === 'admin' || user?.role === 'tax' || user?.role === 'ca';
  const hasClients = companies.some((company) => !company.home);
  const locked = status !== 'draft' || !canWrite;
  const invoiceIssues = useMemo(() => checkInvoice(invoice), [invoice]);
  const totals = useMemo(() => invoiceTotals(invoice), [invoice]);
  const dirty = useMemo(() => !locked && JSON.stringify(invoice) !== savedSnapshot, [invoice, savedSnapshot, locked]);

  /** Asks before throwing away unsaved edits. True when it is fine to go on. */
  const confirmDiscard = () => !dirty || window.confirm('This draft has unsaved changes. Discard them?');

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

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

  // Pop the assistant open once per login session.
  useEffect(() => {
    if (!user) return;
    if (window.sessionStorage.getItem('assistant-greeted')) return;
    window.sessionStorage.setItem('assistant-greeted', '1');
    setIsAssistantOpen(true);
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    api<{ companies: WorkspaceCompany[] }>('/api/workspace/companies')
      .then((result) => setCompanies(result.companies))
      .catch(() => setCompanies([]));
  }, [user?.id]);

  useEffect(() => {
    if (user) refreshBilling();
    else setBilling(null);
  }, [user?.id, user?.organizationId, refreshBilling]);

  // Coming back from PayPal lands on /?billing=...; open the billing page, which finishes the payment.
  useEffect(() => {
    if (user && new URLSearchParams(window.location.search).has('billing')) setView('billing');
  }, [user?.id]);

  const switchCompany = async (organizationId: string) => {
    try {
      const result = await api<{ user: AuthUser }>('/api/workspace/switch', sendJson('POST', { organizationId }));
      setInvoiceId(null);
      setStatus('draft');
      setInvoice(buildNewInvoice(null));
      setActiveModule('editor');
      if (view === 'workspace' || view === 'team' || view === 'company') setView('dashboard');
      setUser(result.user);
      setDataVersion((version) => version + 1);
    } catch (error) {
      window.alert(errorMessage(error, 'Could not switch company.'));
    }
  };

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
        if (!invoiceId) {
          const fresh = buildNewInvoice(result.profile);
          setInvoice(fresh);
          setSavedSnapshot(JSON.stringify(fresh));
        }
      })
      .catch(() => setCompany(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refreshInvoices, refreshBuyers]);

  const loadRecord = (record: InvoiceRecord) => {
    setInvoice(record.invoice);
    setInvoiceId(record.id);
    setStatus(record.status);
    setSavedSnapshot(JSON.stringify(record.invoice));
    setShowAllChecks(false);
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

  /** Payment-record and credit-limit warnings for the buyer, shown before issuing. Never blocks issuing. */
  const creditWarnings = async (): Promise<string[]> => {
    const buyer = invoice.consignee.companyName.trim();
    if (!buyer) return [];
    const amountUsd =
      invoice.items.reduce((sum, item) => sum + (Number(item.totalAmount) || 0), 0) +
      (Number(invoice.freightUsd) || 0) + (Number(invoice.insuranceUsd) || 0) + (Number(invoice.otherChargesUsd) || 0);
    try {
      const check = await api<ShipmentCheck>(`/api/buyers/risk/check?buyer=${encodeURIComponent(buyer)}&amountUsd=${amountUsd.toFixed(2)}`);
      return check.warnings;
    } catch {
      return [];
    }
  };

  const changeStatus = async (next: 'issued' | 'cancelled') => {
    if (next === 'issued') {
      const blocking = invoiceIssues.filter((issue) => issue.severity === 'error');
      if (blocking.length) {
        setShowAllChecks(true);
        setActiveModule('editor');
        setSaveMessage({
          tone: 'error',
          text: `Fix ${blocking.length} thing${blocking.length === 1 ? '' : 's'} before issuing. They are marked in red; the first is: ${blocking[0].message}`,
        });
        return;
      }
    }
    const review = next === 'issued' ? invoiceIssues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message) : [];
    const warnings = next === 'issued' ? [...(await creditWarnings()), ...review.slice(0, 6)] : [];
    const question =
      next === 'issued'
        ? `${warnings.length ? `Please check:\n- ${warnings.join('\n- ')}${review.length > 6 ? `\n- and ${review.length - 6} more` : ''}\n\n` : ''}Issue this invoice? It will be locked and can no longer be edited.`
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

  // Ctrl+S / Cmd+S saves the draft while the editor is open.
  const saveRef = React.useRef(handleSaveInvoice);
  saveRef.current = handleSaveInvoice;
  useEffect(() => {
    if (view !== 'workspace' || locked) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, locked]);

  const handleOpenInvoice = async (id: string) => {
    if (!id || !confirmDiscard()) return;
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
    setSavedSnapshot(JSON.stringify(next));
    setShowAllChecks(false);
    setActiveModule('editor');
    setSaveMessage(message ? { tone: 'ok', text: message } : null);
    setView('workspace');
  };

  const handleNewInvoice = () => confirmDiscard() && startDraft(buildNewInvoice(company?.profile ?? null), null);

  const handleDuplicate = () =>
    confirmDiscard() &&
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
    setIsAssistantOpen(false);
    window.sessionStorage.removeItem('assistant-greeted');
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
        ...(canUseTaxDesk
          ? ([['tax', 'Tax desk', <Landmark className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>)
          : []),
        ['requests', 'Requests', <MessageSquare className="w-4 h-4" />],
        ...(hasClients
          ? ([['practice', 'Practice', <Briefcase className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>)
          : []),
      ],
    },
    {
      label: 'Work',
      items: [
        ['workspace', 'Invoice editor', <FileSpreadsheet className="w-4 h-4" />],
        ['buyers', 'Buyers', <Contact className="w-4 h-4" />],
        ['diamonds', 'Diamonds', <Diamond className="w-4 h-4" />],
      ],
    },
    {
      label: 'Company',
      items: [
        ['company', 'Company', <Building2 className="w-4 h-4" />],
        ...(isAdmin ? ([['team', 'Team', <Users className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>) : []),
        ...(canUseTaxDesk
          ? ([['activity', 'Activity', <History className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>)
          : []),
        ['billing', 'Plan & billing', <CreditCard className="w-4 h-4" />],
        ...(billing?.platformAdmin
          ? ([['bank-transfers', 'Bank transfers', <Landmark className="w-4 h-4" />]] as Array<[View, string, React.ReactNode]>)
          : []),
        ['account', 'Account', <CircleUser className="w-4 h-4" />],
      ],
    },
  ];
  const currentNav = navGroups.flatMap((group) => group.items).find(([key]) => key === view);

  const moduleTabs: Array<[Module, string, React.ReactNode]> = [
    ['editor', 'Details', <FileSpreadsheet className="w-3.5 h-3.5" />],
    ['payments', 'Payments', <Wallet className="w-3.5 h-3.5" />],
    ['erp', 'Tally / SAP', <Layers className="w-3.5 h-3.5" />],
    ['email', 'Email', <Send className="w-3.5 h-3.5" />],
    ['tax', 'Tax papers', <Landmark className="w-3.5 h-3.5" />],
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
          {companies.length > 1 ? (
            <label className="mt-4 block">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-stone-500">Company</span>
              <select
                value={user.organizationId}
                onChange={(event) => switchCompany(event.target.value)}
                className="mt-1 w-full rounded-md border border-white/15 bg-stone-900 px-2 py-1.5 text-xs font-medium text-stone-100"
              >
                {companies.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.home ? '' : ` (${ROLE_LABEL[entry.role]})`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="mt-4 text-xs font-medium text-stone-300 truncate" title={user.organizationName || COMPANY_NAME}>
              {user.organizationName || COMPANY_NAME}
            </p>
          )}
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
        </div>
      </header>
      {billing && (billing.access === 'lapsed' || billing.access === 'grace' || (billing.access === 'trial' && (billing.daysLeft ?? 0) <= 5)) && (
        <div
          role="status"
          className={`flex flex-wrap items-center justify-between gap-2 px-4 md:px-6 py-2 text-xs border-b ${
            billing.access === 'trial' ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <span>
            {billing.access === 'trial' && `Free trial: ${billing.daysLeft} day${billing.daysLeft === 1 ? '' : 's'} left.`}
            {billing.access === 'grace' && 'The last plan payment did not go through. Razorpay is retrying.'}
            {billing.access === 'lapsed' && 'The plan has ended, so this company is read-only. Your data is safe.'}
          </span>
          {view !== 'billing' && (
            <button type="button" onClick={() => setView('billing')} className="font-semibold underline">
              {isAdmin ? 'Choose a plan' : 'See plan'}
            </button>
          )}
        </div>
      )}
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
          canWrite={canWrite}
          initialStatus={invoiceListStatus}
          onOpen={handleOpenInvoice}
          onNew={handleNewInvoice}
        />
      )}
      {view === 'reminders' && <RemindersPage key={dataVersion} readOnly={!canWrite} />}
      {view === 'buyers' && <BuyersPage readOnly={!canWrite} isAdmin={isAdmin} />}
      {view === 'tax' && canUseTaxDesk && (
        <TaxPage
          key={dataVersion}
          isCharteredAccountant={isCharteredAccountant}
          canWrite={canWrite}
          canManage={isAdmin || user.role === 'tax'}
          planFeatures={billing?.features}
          onUpgrade={() => setView('billing')}
          onOpen={handleOpenInvoice}
        />
      )}
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
      {view === 'activity' && canUseTaxDesk && <ActivityPage key={dataVersion} onOpen={handleOpenInvoice} />}
      {view === 'diamonds' && (
        <DiamondsPage
          key={dataVersion}
          canWrite={canWrite}
          isAdmin={isAdmin}
          canUseTaxDesk={canUseTaxDesk}
          onOpen={handleOpenInvoice}
        />
      )}
      {view === 'account' && <AccountPage user={user} />}
      {view === 'billing' && <BillingPage isAdmin={isAdmin} onChanged={refreshBilling} />}
      {view === 'bank-transfers' && billing?.platformAdmin && <BankTransfersAdmin />}
      {view === 'requests' && <RequestsPage key={dataVersion} />}
      {view === 'practice' && hasClients && (
        <PracticePage
          onOpenClient={async (id) => {
            await switchCompany(id);
            setView('tax');
          }}
        />
      )}

      {view === 'workspace' && (
        <>
          <InvoiceToolbar
            invoiceNumber={invoice.shipment.invoiceNumber}
            buyerName={invoice.consignee.companyName}
            route={[invoice.shipment.portOfLoading.split('(')[0].trim(), invoice.shipment.portOfDischarge.split('(')[0].trim()].filter(Boolean).join(' → ')}
            totals={totals}
            status={status}
            dirty={dirty}
            saving={isSaving}
            downloading={isDownloading}
            canWrite={canWrite}
            canCancel={canCancel}
            locked={locked}
            errors={invoiceIssues.filter((issue) => issue.severity === 'error').length}
            invoices={savedInvoices}
            currentId={invoiceId}
            message={saveMessage}
            onOpen={handleOpenInvoice}
            onNew={handleNewInvoice}
            onDuplicate={handleDuplicate}
            onSave={handleSaveInvoice}
            onIssue={() => changeStatus('issued')}
            onCancelInvoice={() => changeStatus('cancelled')}
            onDownload={handleTopDownload}
            onReadManifest={() => setIsAiParserOpen(true)}
            samples={[
              { key: 'surat', label: 'Surat → Antwerp (polished, LUT)' },
              { key: 'mumbai', label: 'Mumbai BDB → New York' },
              { key: 'dubai', label: 'Surat SEZ → Dubai' },
            ]}
            onSample={(key) => {
              const sample = { surat: SURAT_TO_ANTWERP_PRESET, mumbai: MUMBAI_TO_NY_PRESET, dubai: SURAT_TO_DUBAI_PRESET }[key];
              if (sample && window.confirm('Replace everything in this draft with the sample invoice? Your company details will be replaced too.')) {
                editInvoice(structuredClone(sample));
              }
            }}
          />

          <div className="flex-1 flex overflow-hidden">
            <aside className="w-full md:w-[48%] lg:w-[45%] xl:w-[43%] flex flex-col border-r border-slate-300 bg-white shadow-xs z-10 shrink-0">
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
                  <InvoiceEditor
                    invoice={invoice}
                    onChange={editInvoice}
                    issues={invoiceIssues}
                    showAll={showAllChecks}
                    locked={locked}
                    issued={status !== 'draft'}
                    buyers={buyers}
                    onPickBuyer={handlePickBuyer}
                    onSaveBuyer={canWrite ? handleSaveBuyer : undefined}
                    onReadManifest={locked ? undefined : () => setIsAiParserOpen(true)}
                  />
                )}
                {activeModule === 'payments' && (
                  <PaymentsPanel
                    invoiceId={invoiceId}
                    status={status}
                    isAdmin={isAdmin}
                    readOnly={!canWrite}
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
                {activeModule === 'tax' && (
                  <InvoiceTaxPanel
                    invoiceId={invoiceId}
                    canEdit={canWrite}
                    isCharteredAccountant={isCharteredAccountant}
                  />
                )}
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

      {!isAssistantOpen && (
        <button
          onClick={() => setIsAssistantOpen(true)}
          aria-label="Open assistant"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-indigo-600 text-white text-sm font-semibold shadow-lg hover:bg-indigo-700"
        >
          <Bot className="w-5 h-5" />
          Assistant
        </button>
      )}

      {isAssistantOpen && (
        <AssistantPanel
          userId={user.id}
          role={user.role}
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
