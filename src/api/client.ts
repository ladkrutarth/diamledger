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

export type Role = 'admin' | 'member' | 'tax' | 'ca';

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  member: 'Member',
  tax: 'Tax accountant',
  ca: 'Chartered accountant',
};

export type AuthUser = {
  id: string;
  email: string;
  role: Role;
  organizationId: string;
  organizationName: string;
};

// ---------- Two-step sign-in ----------

export type TwoFactorMethod = 'app' | 'sms' | 'recovery';

/** /api/auth/login answers this instead of a user when the account has two-step sign-in on. */
export type TwoFactorChallenge = { twoFactorRequired: true; methods: TwoFactorMethod[]; phoneHint: string | null };

export type LoginResult = { user: AuthUser } | TwoFactorChallenge;

export const needsSecondStep = (result: LoginResult): result is TwoFactorChallenge => 'twoFactorRequired' in result;

export type TwoFactorStatus = {
  enabled: boolean;
  app: boolean;
  phone: string | null;
  recoveryCodesLeft: number;
  appAvailable: boolean;
  smsAvailable: boolean;
  /** Only right after two-step is turned on or codes are renewed: shown once, never again. */
  recoveryCodes?: string[] | null;
};

export type TwoFactorAppSetup = { secret: string; otpauthUrl: string; qrCode: string };

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

export type Payment = {
  id: string;
  amountUsd: number;
  paidOn: string;
  reference: string;
  bankRateInr: number | null;
  createdAt: string;
};

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
  phone?: string;
  createdAt: string;
};

export type ReminderSent = { id: string; status: 'sent'; mode: 'preview_simulated' | 'live_smtp'; sentAt: string };

export type AssistantSource = { kind: 'invoice' | 'buyer' | 'summary' | 'tax'; id?: string; label: string };

export type AssistantActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'failed';

export type AssistantActionKind = 'record_payment' | 'draft_reminder' | 'match_bank_line' | 'close_month';

export type AssistantAction = {
  id: string;
  kind: AssistantActionKind;
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
    lineDate?: string;
    score?: number;
    reasons?: string[];
    month?: string;
    invoiceCount?: number;
  };
  result?: {
    error?: string;
    dueUsd?: number;
    invoiceStatus?: string;
    reminderId?: string;
    subject?: string;
    month?: string;
    closed?: boolean;
  };
  createdAt: string;
};

export type MonthCloseStatus = 'closed' | 'ready' | 'blocked' | 'not_ended';

export type MonthReviewFindings = {
  month: string;
  filing: {
    invoiceCount: number;
    readyCount: number;
    issueCount: number;
    companyIssues: string[];
    invoicesWithIssues: Array<{ invoiceNumber: string; issues: string[] }>;
  };
  register: { count: number; taxableUsd: number; igstUsd: number };
  realization: { openCount: number; openUsd: number; overdueCount: number; dueSoonCount: number; needsBrcCount: number };
  forex: { paymentCount: number; missingRateCount: number; gainInr: number; lossInr: number; netInr: number };
  bank: { unmatchedCount: number; strongMatchCount: number };
  close: { status: MonthCloseStatus; detail: string };
};

export type MonthReview = {
  sessionId: string;
  month: string;
  findings: MonthReviewFindings;
  summary: string;
  explanationSource: 'model' | 'fallback';
  actions: AssistantAction[];
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

export type TeamMember = { id: string; email: string; role: Role; createdAt: string; twoFactor?: boolean };

export type ExportScheme = 'lut' | 'igst';
export type TaxDocumentKind = 'shipping_bill' | 'airway_bill' | 'lut';
export type ReviewStatus = 'query' | 'accepted';

export type ExportRegisterRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  buyerName: string;
  destinationCountry: string;
  status: InvoiceStatus;
  taxableUsd: number;
  totalCarats: number;
  exportScheme: ExportScheme;
  shippingBillNo: string;
  shippingBillDate: string | null;
  igstUsd: number;
  awbNumber: string;
  lutNumber: string;
  reviewStatus: ReviewStatus | null;
  reviewComment: string;
  documents: TaxDocumentKind[];
};

export type RealizationRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  buyerName: string;
  destinationCountry: string;
  totalUsd: number;
  paidUsd: number;
  dueUsd: number;
  bankReferences: string;
  daysSinceShipment: number;
  open: boolean;
  missingReference: boolean;
  shippedOn: string;
  deadline: string;
  daysLeft: number;
  flag: 'overdue' | 'due_soon' | 'open' | 'needs_brc' | 'done';
  brcNumber: string;
  brcDate: string;
  brcAmountUsd: number | null;
};

export type RealizationReport = {
  realizationMonths: number;
  rows: RealizationRow[];
  openCount: number;
  openUsd: number;
  overdueCount: number;
  dueSoonCount: number;
  needsBrcCount: number;
};

export type TaxSettings = { realizationMonths: number; lutValidUntil: string | null; einvoiceRequired: boolean };

export type FilingIssue = { code: string; message: string };

export type FilingCheck = {
  month: string;
  einvoiceRequired: boolean;
  companyIssues: FilingIssue[];
  rows: Array<{
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    exportScheme: ExportScheme;
    shippingBillNo: string;
    irn: string;
    issues: FilingIssue[];
    ready: boolean;
  }>;
  readyCount: number;
  issueCount: number;
};

export type BankSuggestion = {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  dueUsd: number;
  score: number;
  reasons: string[];
  shortByUsd: number;
};

export type BankLine = {
  id: string;
  lineDate: string;
  amountUsd: number;
  bankRateInr: number | null;
  reference: string;
  narration: string;
  status: 'unmatched' | 'matched' | 'ignored';
  invoiceId: string | null;
  invoiceNumber: string | null;
  suggestions: BankSuggestion[];
};

export type ForexRow = {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  paidOn: string;
  amountUsd: number;
  reference: string;
  invoiceRateInr: number | null;
  bankRateInr: number | null;
  invoiceInr: number | null;
  bankInr: number | null;
  gainInr: number | null;
  referenceBankRateInr: number | null;
  referenceBankRateSource: string | null;
  referenceInvoiceRateInr: number | null;
  estimatedGainInr: number | null;
};

export type ForexReport = {
  month: string;
  rows: ForexRow[];
  missingRateCount: number;
  estimatedCount: number;
  estimatedNetInr: number;
  totals: { gainInr: number; lossInr: number; netInr: number };
};

export type WorkspaceCompany = { id: string; name: string; role: Role; home: boolean };

export type CalendarItem = {
  organizationId: string;
  organizationName: string;
  kind: 'gstr1' | 'gstr3b' | 'lut' | 'realization' | 'refund' | 'filing';
  title: string;
  dueDate: string | null;
  daysLeft: number | null;
  status: 'overdue' | 'due_soon' | 'upcoming' | 'done' | 'action';
  detail: string;
};

export type OutsideAccountant = { userId: string; email: string; role: 'ca' | 'tax'; firm: string; createdAt: string };

export type InvoiceTax = {
  exportScheme: ExportScheme;
  shippingBillNo: string;
  shippingBillDate: string;
  igstUsd: number;
  portCode: string;
  sbInvoiceNumber: string;
  sbValueUsd: number | null;
  einvoice: { irn: string; ackNo: string; ackDate: string } | null;
  month: string | null;
  monthClosed: boolean;
  documents: Array<{ id: string; kind: TaxDocumentKind; fileName: string; contentType: string; byteSize: number; createdAt: string }>;
  review: { status: ReviewStatus; comment: string; updatedAt: string } | null;
};

export type ClosedMonth = { month: string; closedAt: string; closedBy: string | null };

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

// ---------- Exchange rates ----------

export type RateInfo = { rateInr: number; source: string; date: string };

export type RatesReport = {
  today: string;
  latest: RateInfo | null;
  reference: Array<{ date: string; rateInr: number; source: string }>;
  company: Array<{ date: string; rateInr: number; note: string }>;
  refreshError: string;
  source: string;
};

// ---------- Activity history ----------

export type AuditEvent = {
  id: string;
  at: string;
  userEmail: string;
  action: string;
  summary: string;
  entityType: string;
  entityId: string;
};

// ---------- AI bank statement reader ----------

export type StatementLine = { date: string; amountUsd: number; reference: string; narration: string; bankRateInr: number | null };

// ---------- GST refund, KP register, certificates ----------

export type RefundRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  buyerName: string;
  destinationCountry: string;
  totalUsd: number;
  exchangeRateInr: number | null;
  valueInr: number | null;
  shippingBillNo: string;
  shippingBillDate: string | null;
  portCode: string;
  fobUsd: number | null;
  fobInr: number | null;
  brcNumber: string;
  brcDate: string;
  brcUsd: number | null;
  issues: string[];
  ready: boolean;
};

export type RefundReport = {
  from: string;
  to: string;
  rows: RefundRow[];
  totals: { invoices: number; ready: number; valueUsd: number; readyValueInr: number; readyFobInr: number };
};

export type KpRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  buyerName: string;
  destinationCountry: string;
  kpcNumber: string;
  hsCodes: string[];
  carats: number;
  roughCarats: number;
  valueUsd: number;
  issues: string[];
};

export type KpReport = {
  from: string;
  to: string;
  rows: KpRow[];
  totals: { shipments: number; withKpc: number; roughCarats: number; carats: number; issues: number };
};

export type CertificateRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  line: number;
  description: string;
  certificateNo: string;
  hsCode: string;
  pieces: number;
  carats: number;
  colorClarity: string;
  shape: string;
  lab: 'GIA' | 'IGI' | 'HRD' | '';
  verifyUrl: string;
  issues: Array<{ tone: 'red' | 'amber'; text: string }>;
};

export type CertificateReport = {
  from: string;
  to: string;
  rows: CertificateRow[];
  totals: { lines: number; certified: number; duplicates: number; warnings: number };
};

// ---------- Parcels ----------

export type Parcel = {
  id: string;
  parcelId: string;
  description: string;
  receivedOn: string | null;
  source: string;
  piecesIn: number;
  caratsIn: number;
  notes: string;
  caratsOut: number;
  piecesOut: number;
  draftCarats: number;
  balanceCarats: number;
  invoices: string[];
  status: 'in_stock' | 'partial' | 'sold' | 'over';
  stockKind: 'rough' | 'polished';
  costInr: number | null;
  madeFrom: string;
  roughCaratsUsed: number | null;
  consumedCarats: number;
};

export type ParcelRegister = {
  parcels: Parcel[];
  unregistered: Array<{ parcelId: string; carats: number; invoices: string[] }>;
  totals: { caratsIn: number; caratsOut: number; balanceCarats: number; overInvoiced: number };
};

// ---------- Buyer portal ----------

export type PortalLink = {
  id: string;
  buyerName: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  createdBy: string;
  active: boolean;
};

export type PortalInvoice = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: string;
  totalUsd: number;
  paidUsd: number;
  dueUsd: number;
  overdue: boolean;
  /** The buyer has reported a bank transfer the exporter has not confirmed yet. */
  claimPending: boolean;
  invoice: import('../types/invoice').InvoiceState;
};

/** How a buyer can pay: online through the exporter's Razorpay account (in rupees), and bank transfer. */
export type PortalPaymentOptions = {
  online: boolean;
  methods: Array<'upi' | 'card' | 'netbanking'>;
  currency: 'INR';
  rateInr: number | null;
  rateSource: string | null;
  testMode: boolean;
  bankTransfer: boolean;
};

/** A Razorpay order for paying an invoice; the page opens Checkout with it. */
export type PortalOrder = {
  orderId: string;
  keyId: string;
  amount: number;
  currency: 'INR';
  amountInr: number;
  amountUsd: number;
  rateInr: number;
  rateSource: string;
  name: string;
  description: string;
};

export type PortalView = {
  exporterName: string;
  buyerName: string;
  expiresAt: string;
  payment: PortalPaymentOptions;
  invoices: PortalInvoice[];
  totals: { invoices: number; dueUsd: number; overdueUsd: number };
};

// ---------- Buyer payments: the exporter's Razorpay account and incoming payments ----------

export type PaymentGateway =
  | { connected: false; encryptionReady: boolean }
  | {
      connected: true;
      keyId: string;
      mode: 'live' | 'test';
      enabled: boolean;
      inrRate: number | null;
      webhookUrl: string;
      webhookSecretSet: boolean;
      encryptionReady: boolean;
      updatedAt: string;
    };

export type PaymentClaim = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  amountUsd: number;
  paidOn: string;
  reference: string;
  payerNote: string;
  status: 'submitted' | 'confirmed' | 'rejected';
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
};

export type OnlinePayment = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  amountUsd: number;
  amountInr: number;
  rateInr: number;
  method: string;
  razorpayPaymentId: string;
  recorded: boolean;
  recordError: string;
  paidAt: string;
};

export type IncomingPayments = { claims: PaymentClaim[]; online: OnlinePayment[] };

// ---------- Cash-flow forecast ----------

export type ForecastInvoice = {
  id: string;
  invoiceNumber: string;
  buyerName: string;
  dueDate: string;
  expectedOn: string;
  balanceUsd: number;
  buyerAvgDaysLate: number | null;
  basis: string;
};

export type ForecastBucket = { expectedUsd: number; invoices: ForecastInvoice[] };

export type CashFlowForecast = {
  today: string;
  weeks: Array<ForecastBucket & { start: string; end: string }>;
  overdue: ForecastBucket;
  later: ForecastBucket;
  totals: { openUsd: number; next4WeeksUsd: number };
};

// ---------- Purchases and input tax credit ----------

export type Purchase = {
  id: string;
  kind: 'import' | 'local';
  supplierName: string;
  supplierGstin: string;
  supplierCountry: string;
  documentNo: string;
  documentDate: string;
  portCode: string;
  description: string;
  carats: number;
  parcelId: string;
  taxableInr: number;
  igstInr: number;
  cgstInr: number;
  sgstInr: number;
  taxInr: number;
  relatedParty: boolean;
  notes: string;
};

export type ItcStatus = 'matched' | 'mismatch' | 'missing_in_2b' | 'not_in_books' | 'itc_blocked';

export type ItcMatch = {
  month: string;
  gstr2bImported: boolean;
  importedMonths: string[];
  rows: Array<{
    status: ItcStatus;
    detail: string;
    purchaseId: string | null;
    supplierName: string;
    supplierGstin: string;
    documentNo: string;
    documentDate: string | null;
    kind: 'import' | 'local';
    booksTaxInr: number | null;
    gstr2bTaxInr: number | null;
    gstr2bMonth: string | null;
  }>;
  totals: { booksItcInr: number; gstr2bItcInr: number; matchedItcInr: number; atRiskItcInr: number; unclaimedItcInr: number; mismatches: number };
};

// ---------- Stock register ----------

export type StockTotals = {
  opening: number;
  purchased: number;
  produced: number;
  consumed: number;
  sold: number;
  closing: number;
  closingValueInr: number;
  parcelsWithoutCost: number;
};

export type StockRegisterReport = {
  year: string;
  parcels: Array<{
    parcelId: string;
    description: string;
    stockKind: 'rough' | 'polished';
    receivedOn: string | null;
    madeFrom: string;
    opening: number;
    received: number;
    consumed: number;
    sold: number;
    closing: number;
    costPerCaratInr: number | null;
    closingValueInr: number | null;
    negative: boolean;
  }>;
  rough: StockTotals;
  polished: StockTotals;
  yieldPercent: number | null;
  processLossCarats: number;
  soldWithoutParcel: { rough: number; polished: number };
  purchaseRegisterCarats: number;
  negativeParcels: string[];
};

// ---------- Audit checks and the tax audit pack ----------

export type AuditFinding = {
  id: string;
  check: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
};

export type AuditChecksReport = {
  findings: AuditFinding[];
  summary: { high: number; medium: number; low: number; byCheck: Record<string, number> };
  labels: Record<string, string>;
};

export type AuditPackReport = {
  year: string;
  turnover: {
    lut: { invoices: number; valueUsd: number; valueInr: number; missingRate: number };
    igst: { invoices: number; valueUsd: number; valueInr: number; missingRate: number };
    totalUsd: number;
    totalInr: number;
    missingRate: number;
    cancelled: number;
  };
  receivables: { totalUsd: number; pastRealizationUsd: number; realizationMonths: number };
  forex: { gainInr: number; lossInr: number; netInr: number; paymentsWithoutRate: number };
  stock: { rough: StockTotals; polished: StockTotals; yieldPercent: number | null; processLossCarats: number; negativeParcels: string[] };
  tds: { count: number; amountInr: number; tdsInr: number; withoutTds: number; withoutTdsInr: number; missing15ca: number; missing15cb: number };
  checks: { high: number; medium: number; low: number };
  summary: Array<[string, string, string, string, string]>;
};

// ---------- Payments abroad (TDS, Form 15CA / 15CB) ----------

export type ForeignPayment = {
  id: string;
  payeeName: string;
  payeeCountry: string;
  nature: 'commission' | 'freight' | 'professional' | 'royalty' | 'interest' | 'other';
  paidOn: string;
  currency: string;
  amountFc: number;
  rateInr: number;
  amountInr: number;
  taxableInIndia: boolean;
  tdsRate: number;
  tdsInr: number;
  dtaaApplied: boolean;
  trcReceived: boolean;
  form15caAck: string;
  form15cbNo: string;
  relatedParty: boolean;
  reference: string;
  notes: string;
  payeeYearInr: number;
  form15caPart: 'A' | 'C' | 'D';
  issues: Array<{ tone: 'red' | 'amber'; text: string }>;
};

export type ForeignPaymentReport = {
  payments: ForeignPayment[];
  totals: { count: number; amountInr: number; tdsInr: number; withoutTds: number; missing15ca: number; missing15cb: number; issues: number };
  threshold15cbInr: number;
};

// ---------- Tally reconciliation ----------

export type TallyReconcileReport = {
  vouchersImported: number;
  rows: Array<{
    area: 'sales' | 'receipts' | 'purchases';
    status: 'matched' | 'amount_differs' | 'date_differs' | 'missing_in_tally' | 'missing_in_app';
    reference: string;
    party: string;
    appDate: string | null;
    tallyDate: string | null;
    appAmount: string;
    tallyAmount: string;
    invoiceId: string | null;
    detail: string;
  }>;
  totals: { matched: number; amountDiffers: number; dateDiffers: number; missingInTally: number; missingInApp: number };
};

// ---------- Requests between accountant and company ----------

export type ClientRequest = {
  id: string;
  title: string;
  detail: string;
  dueDate: string | null;
  overdue: boolean;
  status: 'open' | 'answered' | 'closed';
  invoiceId: string | null;
  invoiceNumber: string | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
  lastMessageAt: string | null;
};

export type ClientRequestMessage = {
  id: string;
  userEmail: string;
  body: string;
  file: { name: string; type: string; size: number } | null;
  createdAt: string;
};

// ---------- Notices ----------

export type TaxNotice = {
  id: string;
  authority: 'gst' | 'income_tax' | 'customs' | 'dgft' | 'rbi' | 'other';
  authorityLabel: string;
  formType: string;
  referenceNo: string;
  period: string;
  issuedOn: string | null;
  replyDue: string | null;
  daysLeft: number | null;
  urgency: 'none' | 'overdue' | 'due_soon' | 'upcoming';
  amountInr: number | null;
  status: 'open' | 'replied' | 'closed';
  summary: string;
  reply: string;
  replySource: string;
  invoiceIds: string[];
  invoiceNumbers: string[];
};

// ---------- Practice (accountant firm) ----------

export type PracticeClient = {
  id: string;
  name: string;
  role: string;
  health: {
    score: number;
    grade: 'good' | 'watch' | 'at_risk';
    overdue: number;
    dueSoon: number;
    actions: number;
    openRequests: number;
    overdueRequests: number;
    openNotices: number;
    noticesDueSoon: number;
    noticesOverdue: number;
    nextItems: Array<{ title: string; dueDate: string | null; status: string }>;
  };
  engagement: { feeInr: number; billing: string; notes: string } | null;
  time: { monthMinutes: number; yearMinutes: number; billableYearMinutes: number };
  fees: { billedYearInr: number; unpaidInr: number; unpaidBills: number };
};

export type PracticeOverview = {
  year: string;
  clients: PracticeClient[];
  totals: { clients: number; atRisk: number; unpaidInr: number; billedYearInr: number; monthMinutes: number };
};

export type PracticeTimeEntry = { id: string; clientId: string; clientName: string; userEmail: string; workDate: string; minutes: number; task: string; billable: boolean };

export type PracticeBill = {
  id: string;
  clientId: string;
  clientName: string;
  billNo: string;
  billDate: string;
  amountInr: number;
  paidOn: string | null;
  daysUnpaid: number | null;
  notes: string;
};

// ---------- Buyer credit risk ----------

export type BuyerRisk = {
  buyerName: string;
  buyerId: string | null;
  invoices: number;
  paidInvoices: number;
  outstandingUsd: number;
  overdueUsd: number;
  maxDaysOverdue: number;
  avgDaysLate: number | null;
  onTimePercent: number | null;
  totalUsd: number;
  lastInvoice: string | null;
  creditLimitUsd: number | null;
  headroomUsd: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'new';
  gradeLabel: string;
};

export type ShipmentCheck = { grade: BuyerRisk['grade']; gradeLabel: string; outstandingUsd: number; creditLimitUsd: number | null; warnings: string[] };

/** Reads a file chosen in the browser as text. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

/** Reads a file chosen in the browser as base64, without the data: prefix. */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

// ---------- Plan and billing ----------

export type BillingCycle = 'monthly' | 'yearly';
export type PlanFeature = 'advanced_tax' | 'audit' | 'ai' | 'outside_accountants' | 'practice';
export type PlanPrice = { baseInr: number; gstInr: number; totalInr: number; totalPaise: number };

export type BillingPlan = {
  key: 'starter' | 'growth' | 'business' | 'ca_firm';
  name: string;
  audience: string;
  monthlyInr: number;
  yearlyInr: number;
  monthlyUsd: number;
  yearlyUsd: number;
  limits: { users: number; invoicesPerMonth: number | null; clients: number | null };
  features: PlanFeature[];
  highlights: string[];
  prices: Record<BillingCycle, PlanPrice>;
  pricesUsd: Record<BillingCycle, number>;
  yearlySavingInr: number;
};

export type BillingSummary = {
  planKey: BillingPlan['key'] | 'trial';
  planName: string;
  cycle: BillingCycle | null;
  status: string;
  access: 'trial' | 'active' | 'grace' | 'lapsed';
  daysLeft: number | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paymentMethod: PaymentProvider | null;
  limits: BillingPlan['limits'];
  features: PlanFeature[];
  usage: { users: number; invoicesThisMonth: number; clients: number };
  paymentOptions: PaymentOptions;
  paymentsEnabled: boolean;
  platformAdmin?: boolean;
  payments: Array<{
    id: string;
    planKey: string;
    cycle: BillingCycle | null;
    amount: number;
    currency: 'INR' | 'USD';
    provider: PaymentProvider;
    status: string;
    method: string;
    paidAt: string;
    /** The GST tax invoice for this payment, once issued. */
    invoiceId: string | null;
    invoiceNumber: string | null;
  }>;
};

/** A GST tax invoice for a subscription payment, as issued (frozen). Amounts are in `currency`. */
export type SubscriptionTaxInvoice = {
  id: string;
  invoiceNumber: string;
  financialYear: string;
  invoiceDate: string;
  seller: { name: string; gstin: string; address: string; state: string; stateCode: string };
  buyer: { name: string; gstin: string; address: string; state: string; stateCode: string; country: string };
  placeOfSupply: string;
  reverseCharge: boolean;
  currency: 'INR' | 'USD';
  lines: Array<{ description: string; sac: string; quantity: number; taxableValue: number }>;
  taxableValue: number;
  cgstRate: number;
  cgst: number;
  sgstRate: number;
  sgst: number;
  igstRate: number;
  igst: number;
  total: number;
  payment: { id: string; provider: PaymentProvider; method: string; paidAt: string };
  notes: string[];
};

export type PaymentProvider = 'razorpay' | 'bank_transfer' | 'paypal';
export type PaymentOptions = { upi: boolean; card: boolean; netbanking: boolean; bankTransfer: boolean; paypal: boolean };

export type SellerBankAccount = {
  accountName: string;
  bankName: string;
  accountNumber: string;
  ifsc: string;
  branch: string;
  accountType: string;
  gstin: string;
};

export type BankTransfer = {
  id: string;
  organizationId: string;
  organizationName?: string;
  planKey: BillingPlan['key'];
  planName: string;
  cycle: BillingCycle;
  amountInr: number;
  referenceCode: string;
  status: 'awaiting' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  utr: string;
  paidOn: string | null;
  payerBank: string;
  note: string;
  createdByEmail: string;
  reviewedByEmail: string;
  reviewedAt: string | null;
  reviewNote: string;
  createdAt: string;
};

export type CheckoutStart = {
  subscriptionId: string;
  keyId: string;
  name: string;
  description: string;
  amountInr: number;
  prefill: { email: string; name: string };
};
