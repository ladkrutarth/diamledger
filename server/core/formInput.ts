import { parseLooseDate } from '../modules/tax/taxShared.js';

/** Thrown by a form reader; the message is shown to the user as a 400 error. */
export class FormError extends Error {
  readonly status = 400;
}

/** Small readers for JSON request bodies. Each throws FormError with a message the user can act on. */
export function formReader(body: unknown) {
  const value = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  const text = (key: string, max = 500): string => {
    const raw = value[key];
    if (typeof raw === 'number') return String(raw).slice(0, max);
    return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
  };

  const required = (key: string, message: string, max = 500): string => {
    const found = text(key, max);
    if (!found) throw new FormError(message);
    return found;
  };

  const number = (key: string, message: string, options: { min?: number; max?: number; optional?: boolean; places?: number } = {}) => {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === '') {
      if (options.optional) return null;
      throw new FormError(message);
    }
    const parsed = Number(typeof raw === 'string' ? raw.replace(/,/g, '') : raw);
    if (!Number.isFinite(parsed)) throw new FormError(message);
    if (options.min !== undefined && parsed < options.min) throw new FormError(message);
    if (options.max !== undefined && parsed > options.max) throw new FormError(message);
    const factor = 10 ** (options.places ?? 2);
    return Math.round(parsed * factor) / factor;
  };

  const date = (key: string, message: string, optional = false): string | null => {
    const raw = text(key, 20);
    if (!raw) {
      if (optional) return null;
      throw new FormError(message);
    }
    const parsed = parseLooseDate(raw);
    if (!parsed) throw new FormError(message);
    return parsed;
  };

  const flag = (key: string): boolean => value[key] === true || value[key] === 'true';

  const choice = <T extends string>(key: string, options: readonly T[], fallback?: T): T => {
    const raw = text(key, 50);
    if ((options as readonly string[]).includes(raw)) return raw as T;
    if (fallback !== undefined) return fallback;
    throw new FormError(`Choose one of: ${options.join(', ')}.`);
  };

  return { raw: value, text, required, number, date, flag, choice };
}

/** Upper case letters and digits only, without leading zeros in a number, so "INV/007" matches "inv-7". */
export function documentKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|[A-Z])0+(?=[0-9])/g, '$1');
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Start and end dates of an Indian financial year written as 2026-27. */
export function financialYearDates(token: string): { start: string; end: string; label: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(token);
  if (!match) return null;
  const startYear = Number(match[1]);
  if (Number(match[2]) !== (startYear + 1) % 100) return null;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, label: token };
}

export function currentFinancialYear(today = new Date()): string {
  const startYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
