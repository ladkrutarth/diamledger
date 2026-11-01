import type { BankDetails, ConsigneeDetails, ExporterDetails, InvoiceState } from '../types/invoice';

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.body = body;
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
  collectedThisMonth: { count: number; totalUsd: number };
  months: Array<{ month: string; label: string; count: number; totalUsd: number }>;
  byCountry: Array<{ country: string; count: number; totalUsd: number }>;
  aging: Array<{ key: string; label: string; count: number; dueUsd: number }>;
  topBuyers: Array<{ buyer: string; invoices: number; dueUsd: number; overdueUsd: number }>;
  unpaid: {
    count: number;
    dueUsd: number;
    invoices: Array<{
      id: string;
      invoiceNumber: string;
      buyerName: string;
      invoiceDate: string | null;
      dueDate: string;
      daysOverdue: number;
      overdue: boolean;
      totalUsd: number;
      paidUsd: number;
      dueUsd: number;
    }>;
  };
  statusCounts: Record<InvoiceStatus, number>;
};

export type OverdueInvoice = {
  id: string;
  invoiceNumber: string;
  buyerName: string;
  buyerEmail: string;
  invoiceDate: string | null;
  dueDate: string;
  daysOverdue: number;
  totalUsd: number;
  paidUsd: number;
  dueUsd: number;
  remindersSent: number;
  lastReminderAt: string | null;
  recentlyReminded: boolean;
};

export type ReminderFigures = {
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string;
  daysOverdue: number;
  totalUsd: number;
  paidUsd: number;
  dueUsd: number;
  paymentTerms: string;
  exporterName: string;
  signatoryName: string;
  signatoryDesignation: string;
  bank: { bankName: string; accountNumber: string; swiftCode: string; iban: string };
};

export type ReminderDraft = {
  id: string;
  invoiceId: string;
  status: 'draft';
  source: 'model' | 'template';
  tone: 'gentle' | 'firm' | 'final';
  subject: string;
  greeting: string;
  paragraphs: string[];
  fullSubject: string;
  html: string;
  recipients: string[];
  figures: ReminderFigures;
  createdAt: string;
};

export type ReminderSent = { id: string; status: 'sent'; mode: 'preview_simulated' | 'live_smtp'; sentAt: string };

export type AssistantSource = { kind: 'invoice' | 'buyer' | 'summary'; id?: string; label: string };

export type AssistantActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'failed';

export type AssistantAction = {
  id: string;
  kind: 'record_payment' | 'draft_reminder';
  status: AssistantActionStatus;
  payload: {
    invoiceNumber?: string;
    buyer?: string;
    amountUsd?: number;
    paidOn?: string;
    reference?: string;
    dueUsd?: number;
    dueUsdAtProposal?: number;
    daysOverdue?: number;
    remindedInLastWeek?: boolean;
  };
  result?: { error?: string; dueUsd?: number; invoiceStatus?: string; reminderId?: string; subject?: string };
  createdAt: string;
};

export type AssistantMessage = { id: string; role: 'user' | 'model'; text: string; createdAt: string };

export type AssistantSession = {
  id: string;
  createdAt: string;
  messages: AssistantMessage[];
  actions: AssistantAction[];
};

export type AssistantTurn = {
  reply: string;
  sources: AssistantSource[];
  actions: AssistantAction[];
  ungrounded: boolean;
  stepLimitReached: boolean;
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
  let body: ({ error?: string } & Record<string, unknown>) | null = null;
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
    throw new ApiError(response.status, body?.error || 'Request failed.', body);
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
