import React, { createContext, useContext, useEffect, useId, useState } from 'react';
import type { InvoiceIssue } from './invoiceChecks';

/** Lets every field find its own problems without passing them down by hand. */
type EditorContextValue = { issues: Map<string, InvoiceIssue[]>; showAll: boolean };
export const EditorContext = createContext<EditorContextValue>({ issues: new Map(), showAll: false });

function useFieldIssue(field?: string): InvoiceIssue | undefined {
  const { issues, showAll } = useContext(EditorContext);
  if (!field) return undefined;
  const found = issues.get(field) ?? [];
  const visible = found.filter((issue) => showAll || issue.kind === 'invalid');
  return visible.find((issue) => issue.severity === 'error') ?? visible[0];
}

const base =
  'w-full rounded-md border bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:ring-2 disabled:bg-slate-50 disabled:text-slate-500';

function inputTone(issue?: InvoiceIssue) {
  if (issue?.severity === 'error') return 'border-red-400 focus:border-red-500 focus:ring-red-100';
  if (issue?.severity === 'warning') return 'border-amber-400 focus:border-amber-500 focus:ring-amber-100';
  return 'border-slate-300 focus:border-slate-900 focus:ring-slate-100';
}

type Shared = {
  label: string;
  /** Dotted path matching InvoiceIssue.field, for inline messages. */
  field?: string;
  hint?: string;
  required?: boolean;
  className?: string;
};

const FieldShell: React.FC<Shared & { id: string; issue?: InvoiceIssue; children: React.ReactNode }> = ({ label, hint, required, className = '', id, issue, children }) => (
  <div className={className} data-field-anchor>
    <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700">
      {label}
      {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
    </label>
    {children}
    {issue ? (
      <p id={`${id}-msg`} className={`mt-1 text-[11px] ${issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}`}>
        {issue.message}
      </p>
    ) : (
      hint && <p id={`${id}-msg`} className="mt-1 text-[11px] text-slate-500">{hint}</p>
    )}
  </div>
);

export const TextField: React.FC<
  Shared & {
    value: string | undefined;
    onChange: (value: string) => void;
    placeholder?: string;
    mono?: boolean;
    uppercase?: boolean;
    type?: 'text' | 'date' | 'email' | 'tel';
    maxLength?: number;
  }
> = ({ value, onChange, placeholder, mono, uppercase, type = 'text', maxLength, ...shared }) => {
  const id = useId();
  const issue = useFieldIssue(shared.field);
  return (
    <FieldShell {...shared} id={id} issue={issue}>
      <input
        id={id}
        type={type}
        value={value ?? ''}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={issue?.severity === 'error' || undefined}
        aria-describedby={issue || shared.hint ? `${id}-msg` : undefined}
        onChange={(event) => onChange(uppercase ? event.target.value.toUpperCase() : event.target.value)}
        className={`${base} ${inputTone(issue)} ${mono ? 'font-mono tracking-tight' : ''}`}
      />
    </FieldShell>
  );
};

/**
 * Keeps what the user types (such as "1." on the way to "1.25") and only reports a number once it parses,
 * so decimals can be typed naturally.
 */
export const NumberField: React.FC<
  Shared & {
    value: number;
    onChange: (value: number) => void;
    step?: number;
    min?: number;
    integer?: boolean;
    prefix?: string;
    suffix?: string;
    align?: 'left' | 'right';
  }
> = ({ value, onChange, step, min, integer, prefix, suffix, align = 'right', ...shared }) => {
  const id = useId();
  const issue = useFieldIssue(shared.field);
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  useEffect(() => {
    // Follow outside changes (another field, a preset, the manifest reader) unless it is the same number.
    if (Number(text) !== value) setText(Number.isFinite(value) ? String(value) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <FieldShell {...shared} id={id} issue={issue}>
      <div className={`flex items-center rounded-md border bg-white focus-within:ring-2 ${inputTone(issue)}`}>
        {prefix && <span className="pl-2.5 text-xs text-slate-500">{prefix}</span>}
        <input
          id={id}
          inputMode={integer ? 'numeric' : 'decimal'}
          value={text}
          step={step}
          min={min}
          aria-invalid={issue?.severity === 'error' || undefined}
          aria-describedby={issue || shared.hint ? `${id}-msg` : undefined}
          onChange={(event) => {
            const next = event.target.value.replace(/[^0-9.\-]/g, '');
            setText(next);
            if (next === '' || next === '-') return onChange(0);
            const parsed = integer ? parseInt(next, 10) : Number(next);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={() => setText(Number.isFinite(value) ? String(value) : '')}
          className={`w-full min-w-0 rounded-md bg-transparent px-2.5 py-1.5 text-sm font-mono tabular-nums text-slate-900 outline-none ${align === 'right' ? 'text-right' : ''}`}
        />
        {suffix && <span className="pr-2.5 text-xs text-slate-500">{suffix}</span>}
      </div>
    </FieldShell>
  );
};

export const SelectField: React.FC<Shared & { value: string; options: Array<[string, string]>; onChange: (value: string) => void }> = ({
  value,
  options,
  onChange,
  ...shared
}) => {
  const id = useId();
  const issue = useFieldIssue(shared.field);
  return (
    <FieldShell {...shared} id={id} issue={issue}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={`${base} ${inputTone(issue)}`}>
        {options.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
};

export const TextAreaField: React.FC<Shared & { value: string | undefined; onChange: (value: string) => void; rows?: number; placeholder?: string }> = ({
  value,
  onChange,
  rows = 2,
  placeholder,
  ...shared
}) => {
  const id = useId();
  const issue = useFieldIssue(shared.field);
  return (
    <FieldShell {...shared} id={id} issue={issue}>
      <textarea id={id} rows={rows} value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`${base} ${inputTone(issue)}`} />
    </FieldShell>
  );
};

/** A declaration the exporter signs: the checkbox, its wording, and any problem with it. */
export const DeclarationField: React.FC<{ field: string; checked: boolean; title: string; text: string; onChange: (checked: boolean) => void }> = ({
  field,
  checked,
  title,
  text,
  onChange,
}) => {
  const issue = useFieldIssue(field);
  return (
    <label
      data-field-anchor
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
        issue?.severity === 'error' ? 'border-red-300 bg-red-50/40' : checked ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50'
      }`}
    >
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
      <span>
        <span className="block text-sm font-medium text-slate-900">{title}</span>
        <span className="block text-xs text-slate-600 leading-relaxed">{text}</span>
        {issue && <span className={`mt-1 block text-[11px] ${issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}`}>{issue.message}</span>}
      </span>
    </label>
  );
};

export const Section: React.FC<{
  id: string;
  title: string;
  description?: string;
  counts?: { errors: number; warnings: number };
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, description, counts, actions, children }) => (
  <section id={id} className="scroll-mt-24 rounded-xl border border-slate-200 bg-white">
    <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
          {title}
          {counts && counts.errors > 0 && <span className="rounded-full bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">{counts.errors}</span>}
          {counts && counts.errors === 0 && counts.warnings > 0 && (
            <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">{counts.warnings}</span>
          )}
        </h3>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      {actions}
    </header>
    <div className="space-y-4 p-4">{children}</div>
  </section>
);

export const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</h4>
);
