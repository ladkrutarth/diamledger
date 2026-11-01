import React from 'react';

export const head = 'px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500';
export const cell = 'px-2 py-2 border-t border-slate-100 align-top';

export function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function previousMonth(): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value);
}

export const TableHead: React.FC<{ labels: string[] }> = ({ labels }) => (
  <thead>
    <tr>
      {labels.map((label) => (
        <th key={label} className={head}>
          {label}
        </th>
      ))}
    </tr>
  </thead>
);

export const InvoiceLink: React.FC<{ id: string; number: string; date?: string | null; onOpen: (id: string) => void }> = ({
  id,
  number,
  date,
  onOpen,
}) => (
  <>
    <button type="button" onClick={() => onOpen(id)} className="whitespace-nowrap text-left font-semibold text-slate-950 hover:underline">
      {number}
    </button>
    {date ? <p className="text-xs text-slate-500">{date}</p> : null}
  </>
);

const BADGE_TONES = {
  red: 'bg-red-50 text-red-800 border-red-200',
  amber: 'bg-amber-50 text-amber-900 border-amber-200',
  green: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  slate: 'bg-slate-50 text-slate-700 border-slate-200',
};

export const Badge: React.FC<{ tone: keyof typeof BADGE_TONES; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BADGE_TONES[tone]}`}>
    {children}
  </span>
);
