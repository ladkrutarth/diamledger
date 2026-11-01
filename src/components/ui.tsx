import React from 'react';

export const primaryButton =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50';
export const secondaryButton =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-50';
export const dangerButton =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg disabled:opacity-50';
export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-slate-900';

export const Page: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, actions, children }) => (
  <div className="flex-1 overflow-y-auto">
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-950">{title}</h1>
          {description && <p className="text-sm text-slate-600 mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  </div>
);

export const Card: React.FC<{ title?: string; children: React.ReactNode; className?: string }> = ({
  title,
  children,
  className = '',
}) => (
  <section className={`bg-white border border-slate-200 rounded-xl shadow-xs p-4 ${className}`}>
    {title && <h2 className="text-sm font-semibold text-slate-900 mb-3">{title}</h2>}
    {children}
  </section>
);

export const Field: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
}> = ({ label, value, onChange, type = 'text', placeholder, required, minLength, autoComplete }) => {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-semibold text-slate-600 mb-1">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </div>
  );
};

export const Notice: React.FC<{ tone?: 'error' | 'success' | 'info'; children: React.ReactNode }> = ({
  tone = 'info',
  children,
}) => {
  const styles = {
    error: 'text-red-700 bg-red-50 border-red-200',
    success: 'text-emerald-800 bg-emerald-50 border-emerald-200',
    info: 'text-slate-700 bg-slate-50 border-slate-200',
  }[tone];
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`text-sm border rounded-lg px-3 py-2 ${styles}`}>
      {children}
    </p>
  );
};
