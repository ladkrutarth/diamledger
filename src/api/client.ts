import type { BankDetails, ConsigneeDetails, ExporterDetails, InvoiceState } from '../types/invoice';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Role = 'admin' | 'member';

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
  organizationId: string;
  organizationName: string;
};

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'cancelled';

export type InvoiceSummary = {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  buyerName: string;
  destinationCountry: string;
  invoiceDate: string | null;
  totalUsd: number;
  totalCarats: number;
  paidUsd: number;
  dueUsd: number;
  updatedAt: string;
};

export type InvoiceRecord = InvoiceSummary & { invoice: InvoiceState };

export type CompanyProfile = {
  invoicePrefix: string;
  authorizedSignatoryName: string;
  authorizedSignatoryDesignation: string;
  exporter: Partial<ExporterDetails>;
  bank: Partial<BankDetails>;
};

export type Company = { name: string; profile: CompanyProfile | null };

export type BuyerContact = Pick<
  ConsigneeDetails,
  | 'companyName'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'state'
  | 'country'
  | 'postalCode'
  | 'taxIdVat'
  | 'contactPerson'
  | 'email'
  | 'phone'
>;

export type Buyer = { id: string; name: string; consignee: BuyerContact; updatedAt: string };

export type Payment = { id: string; amountUsd: number; paidOn: string; reference: string; createdAt: string };

export type PaymentState = {
  status: InvoiceStatus;
  totalUsd: number;
  paidUsd: number;
  dueUsd: number;
  payments: Payment[];
};

export type Dashboard = {
  thisMonth: { count: number; totalUsd: number; totalCarats: number };
  byCountry: Array<{ country: string; count: number; totalUsd: number }>;
  unpaid: {
    count: number;
    dueUsd: number;
    invoices: Array<{
      id: string;
      invoiceNumber: string;
      buyerName: string;
      invoiceDate: string | null;
      totalUsd: number;
      paidUsd: number;
      dueUsd: number;
    }>;
  };
  statusCounts: Record<InvoiceStatus, number>;
};

export type TeamMember = { id: string; email: string; role: Role; createdAt: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  let body: { error?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.status,
        'The sign-in API is not running on this site. Redeploy the latest code, then set DATABASE_URL and SESSION_SECRET in Vercel.',
      );
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error || 'Request failed.');
  }
  return body as T;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function sendJson(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export function queryString(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
