import React from 'react';
import { api, errorMessage } from '../api/client';

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

export const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: 'red' | 'green' | 'amber' }> = ({ label, value, tone }) => (
  <div>
    <p className="text-xs text-slate-500">{label}</p>
    <p
      className={`text-lg font-semibold tabular-nums ${
        tone === 'red' ? 'text-red-700' : tone === 'green' ? 'text-emerald-800' : tone === 'amber' ? 'text-amber-800' : ''
      }`}
    >
      {value}
    </p>
  </div>
);

/** Loads JSON from a path whenever the path changes; reload() fetches it again. */
export function useReport<T>(path: string | null, fallbackError: string) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState('');
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    if (!path) return;
    let current = true;
    api<T>(path)
      .then((result) => {
        if (!current) return;
        setData(result);
        setError('');
      })
      .catch((err) => current && setError(errorMessage(err, fallbackError)));
    return () => {
      current = false;
    };
  }, [path, version, fallbackError]);
  return { data, error, setError, reload: () => setVersion((value) => value + 1) };
}

const labelClass = 'block text-[11px] font-semibold text-slate-600 mb-1';

export const SelectField: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-900"
      >
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
};

export const CheckField: React.FC<{ label: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center gap-2 text-sm text-slate-700 pt-5">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    {label}
  </label>
);

export const TextAreaField: React.FC<{ label: string; value: string; rows?: number; placeholder?: string; onChange: (value: string) => void }> = ({
  label,
  value,
  rows = 4,
  placeholder,
  onChange,
}) => {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-900"
      />
    </div>
  );
};

export function financialYearOf(date = new Date()): string {
  const start = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const YearField: React.FC<{ value: string; onChange: (value: string) => void }> = ({ value, onChange }) => {
  const now = new Date();
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const years = Array.from({ length: 5 }, (_, index) => {
    const year = start - index;
    return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  });
  return <SelectField label="Financial year" value={value} options={years.map((year) => [year, year])} onChange={onChange} />;
};
