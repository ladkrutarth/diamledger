import React from 'react';
import type { InvoiceStatus } from '../api/client';

const STYLES: Record<InvoiceStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-300',
  issued: 'bg-sky-50 text-sky-800 border-sky-200',
  paid: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

const LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  issued: 'Issued',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export const StatusBadge: React.FC<{ status: InvoiceStatus }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STYLES[status]}`}>
    <span className="w-1.5 h-1.5 rounded-full bg-current" />
    {LABELS[status]}
  </span>
);
