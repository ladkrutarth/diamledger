import React, { useEffect, useRef, useState } from 'react';
import { Ban, ChevronDown, Copy, Download, FilePlus2, FolderOpen, Lock, MoreHorizontal, Save, Send, Sparkles } from 'lucide-react';
import type { InvoiceStatus, InvoiceSummary } from '../../../api/client';
import { StatusBadge } from '../../../components/StatusBadge';
import type { InvoiceTotals } from './invoiceChecks';

type Props = {
  invoiceNumber: string;
  buyerName: string;
  route: string;
  totals: InvoiceTotals;
  status: InvoiceStatus;
  dirty: boolean;
  saving: boolean;
  downloading: boolean;
  canWrite: boolean;
  canCancel: boolean;
  locked: boolean;
  errors: number;
  invoices: InvoiceSummary[];
  currentId: string | null;
  message: { tone: 'ok' | 'error'; text: string } | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onSave: () => void;
  onIssue: () => void;
  onCancelInvoice: () => void;
  onDownload: () => void;
  onReadManifest: () => void;
  samples: Array<{ key: string; label: string }>;
  onSample: (key: string) => void;
};

const button =
  'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50';

/** Shortcut label for the platform: ⌘S on a Mac, Ctrl+S elsewhere. */
const saveShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

export const InvoiceToolbar: React.FC<Props> = (props) => {
  const [menu, setMenu] = useState<'open' | 'more' | null>(null);
  const close = React.useCallback(() => setMenu(null), []);
  const ref = useDismiss(menu !== null, close);
  const { totals } = props;
  const draft = props.status === 'draft';

  return (
    <div ref={ref} className="shrink-0 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold text-slate-950">{props.invoiceNumber || 'New invoice'}</h1>
            <StatusBadge status={props.status} />
            {draft && props.canWrite && (
              <span className={`text-[11px] ${props.dirty ? 'text-amber-700' : 'text-slate-500'}`}>
                {props.dirty ? '● Unsaved changes' : props.currentId ? 'Saved' : 'Not saved yet'}
              </span>
            )}
            {props.locked && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Lock className="h-3 w-3" /> Locked
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {[props.buyerName || 'No buyer yet', props.route, `${totals.carats.toFixed(3)} ct`, `$${totals.totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button type="button" className={button} aria-haspopup="menu" aria-expanded={menu === 'open'} onClick={() => setMenu(menu === 'open' ? null : 'open')}>
              <FolderOpen className="h-3.5 w-3.5" /> Open <ChevronDown className="h-3 w-3" />
            </button>
            {menu === 'open' && (
              <div role="menu" className="absolute right-0 z-30 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                {props.invoices.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No saved invoices yet.</p>}
                {props.invoices.slice(0, 50).map((saved) => (
                  <button
                    key={saved.id}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      close();
                      props.onOpen(saved.id);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-50 ${saved.id === props.currentId ? 'bg-slate-50 font-semibold' : ''}`}
                  >
                    <span className="truncate">
                      <span className="font-mono">{saved.invoiceNumber}</span>
                      {saved.buyerName ? <span className="text-slate-500"> · {saved.buyerName}</span> : null}
                    </span>
                    <StatusBadge status={saved.status} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {props.canWrite && (
            <>
              <button type="button" onClick={props.onNew} className={button}>
                <FilePlus2 className="h-3.5 w-3.5" /> New
              </button>
              <button type="button" onClick={props.onDuplicate} className={button} title="Copy this invoice into a new draft">
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </button>
              <div className="relative">
                <button type="button" className={button} aria-label="More actions" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                {menu === 'more' && (
                  <div role="menu" className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg">
                    <button
                      role="menuitem"
                      type="button"
                      disabled={props.locked}
                      onClick={() => {
                        close();
                        props.onReadManifest();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 disabled:opacity-40"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> Read lines from a manifest (AI)
                    </button>
                    {draft && !props.locked && (
                      <>
                        <p className="mt-1 border-t border-slate-100 px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Fill with a sample</p>
                        {props.samples.map((sample) => (
                          <button
                            key={sample.key}
                            role="menuitem"
                            type="button"
                            onClick={() => {
                              close();
                              props.onSample(sample.key);
                            }}
                            className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
                          >
                            {sample.label}
                          </button>
                        ))}
                      </>
                    )}
                    {props.canCancel && (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          close();
                          props.onCancelInvoice();
                        }}
                        className="mt-1 flex w-full items-center gap-2 border-t border-slate-100 px-3 py-1.5 pt-2 text-left text-red-700 hover:bg-red-50"
                      >
                        <Ban className="h-3.5 w-3.5" /> {draft ? 'Cancel this draft' : 'Cancel invoice'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {draft && (
                <>
                  <button type="button" onClick={props.onSave} disabled={props.saving || props.locked} className={button} title={`Save draft (${saveShortcut})`}>
                    <Save className="h-3.5 w-3.5" /> {props.saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={props.onIssue}
                    disabled={props.saving}
                    title={props.errors ? `${props.errors} thing${props.errors === 1 ? '' : 's'} to fix first` : 'Lock the invoice and give it its final number'}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" /> Issue
                    {props.errors > 0 && <span className="rounded-full bg-white/25 px-1.5 text-[10px]">{props.errors}</span>}
                  </button>
                </>
              )}
            </>
          )}
          <button
            type="button"
            onClick={props.onDownload}
            disabled={props.downloading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> {props.downloading ? 'Preparing…' : 'PDF'}
          </button>
        </div>
      </div>
      {props.message && (
        <p role={props.message.tone === 'error' ? 'alert' : 'status'} className={`px-4 pb-2 text-xs ${props.message.tone === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
          {props.message.text}
        </p>
      )}
      {props.locked && props.status !== 'draft' && (
        <p className="flex items-center gap-1.5 border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-900">
          <Lock className="h-3 w-3" /> This invoice is {props.status} and cannot change. Use Duplicate to start a new draft from it.
        </p>
      )}
    </div>
  );
};
