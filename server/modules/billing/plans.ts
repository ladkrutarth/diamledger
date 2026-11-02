/**
 * Subscription plans, priced in Indian rupees for the Indian market.
 *
 * Prices are per company and exclude GST. GST at 18% is added at checkout, because software sold as a
 * service in India carries 18% GST. Annual billing is 10 times the monthly price (two months free),
 * close to the roughly 17% annual discount other Indian accounting software offers.
 *
 * Positioning (checked November 2026): general GST accounting such as Zoho Books runs ₹899–₹9,999 a month
 * and TallyPrime Silver rents for about ₹750 a month; jewellery ERPs list around ₹25,000–₹40,000 a year;
 * CA practice tools list about ₹5,000–₹55,000 a year. These plans sit above general accounting because
 * they add export compliance (LUT, shipping bills, FEMA realization, e-BRC, KP), diamond stock, the tax
 * audit pack, and AI, which an exporter would otherwise buy as accountant hours.
 */

export const GST_RATE = 0.18;
export const TRIAL_DAYS = 14;
/** Days after a paid period ends before the company becomes read-only, while the bank retries the charge. */
export const GRACE_DAYS = 3;

export type BillingCycle = 'monthly' | 'yearly';
export type PlanKey = 'starter' | 'growth' | 'business' | 'ca_firm';

export type Feature =
  | 'advanced_tax' // purchases & ITC, payments abroad / TDS, Tally match, notices
  | 'audit' // audit checks and the Form 3CD pack
  | 'ai' // assistant, month review, AI drafting and reading
  | 'outside_accountants' // give a CA firm access to this company
  | 'practice'; // accountant practice tools across client companies

export type Plan = {
  key: PlanKey;
  name: string;
  audience: string;
  monthlyInr: number;
  yearlyInr: number;
  limits: { users: number; invoicesPerMonth: number | null; clients: number | null };
  features: Feature[];
  highlights: string[];
};

export const PLANS: Plan[] = [
  {
    key: 'starter',
    name: 'Starter',
    audience: 'A small exporter starting out',
    monthlyInr: 1499,
    yearlyInr: 14990,
    limits: { users: 2, invoicesPerMonth: 30, clients: null },
    features: [],
    highlights: [
      '2 users, 30 issued invoices a month',
      'Export invoices, PDF, Tally XML, SAP',
      'Payments, buyers, collections, dashboard',
      'Filing check, export register, realization, forex, bank match',
      'Parcels, stock register, KP register',
    ],
  },
  {
    key: 'growth',
    name: 'Growth',
    audience: 'An exporter with an accountant',
    monthlyInr: 3999,
    yearlyInr: 39990,
    limits: { users: 5, invoicesPerMonth: 150, clients: null },
    features: ['advanced_tax', 'ai', 'outside_accountants'],
    highlights: [
      'Everything in Starter',
      '5 users, 150 issued invoices a month',
      'Purchases & GSTR-2B credit match, TDS on payments abroad',
      'Tally match, notices with drafted replies',
      'AI assistant, month review, statement and manifest reading',
      'Give your CA firm access',
    ],
  },
  {
    key: 'business',
    name: 'Business',
    audience: 'A larger exporter preparing for tax audit',
    monthlyInr: 7999,
    yearlyInr: 79990,
    limits: { users: 15, invoicesPerMonth: null, clients: null },
    features: ['advanced_tax', 'audit', 'ai', 'outside_accountants'],
    highlights: [
      'Everything in Growth',
      '15 users, unlimited invoices',
      'Automatic audit checks',
      'Form 3CD tax audit pack',
    ],
  },
  {
    key: 'ca_firm',
    name: 'CA Firm',
    audience: 'A chartered accountant firm serving exporters',
    monthlyInr: 2499,
    yearlyInr: 24990,
    limits: { users: 5, invoicesPerMonth: 30, clients: 25 },
    features: ['practice', 'ai'],
    highlights: [
      '5 staff, up to 25 client companies',
      'Practice view: client health, time, fee bills',
      "Work inside each client's company on the client's own plan",
      'Requests and notices with each client',
    ],
  },
];

/** What a trial gets: everything, with Business limits. */
export const TRIAL_PLAN: Plan = {
  key: 'business',
  name: 'Free trial',
  audience: 'Every feature for 14 days',
  monthlyInr: 0,
  yearlyInr: 0,
  limits: { users: 15, invoicesPerMonth: null, clients: 25 },
  features: ['advanced_tax', 'audit', 'ai', 'outside_accountants', 'practice'],
  highlights: [],
};

export const FEATURE_LABELS: Record<Feature, { label: string; plan: string }> = {
  advanced_tax: { label: 'Purchases & ITC, TDS, Tally match, and notices', plan: 'Growth' },
  audit: { label: 'Audit checks and the tax audit pack', plan: 'Business' },
  ai: { label: 'AI features', plan: 'Growth' },
  outside_accountants: { label: 'Outside accountant access', plan: 'Growth' },
  practice: { label: 'The practice tools', plan: 'CA Firm' },
};

export function planByKey(key: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.key === key);
}

export function isCycle(value: unknown): value is BillingCycle {
  return value === 'monthly' || value === 'yearly';
}

/** Price before GST, GST, and the total charged, in rupees. Totals are rounded to the rupee. */
export function priceFor(plan: Plan, cycle: BillingCycle) {
  const base = cycle === 'monthly' ? plan.monthlyInr : plan.yearlyInr;
  const gst = Math.round(base * GST_RATE);
  return { baseInr: base, gstInr: gst, totalInr: base + gst, totalPaise: (base + gst) * 100 };
}

/** Each plan with its prices, as shown on the pricing page. */
export function publicPlans() {
  return PLANS.map((plan) => ({
    ...plan,
    prices: { monthly: priceFor(plan, 'monthly'), yearly: priceFor(plan, 'yearly') },
    yearlySavingInr: plan.monthlyInr * 12 - plan.yearlyInr,
  }));
}

/**
 * Which feature a request path needs. Paths not listed are on every plan. Reads are gated too, so a
 * locked desk explains itself instead of showing an empty table.
 */
export function featureForPath(path: string): Feature | null {
  if (/^\/api\/(purchases|foreign-payments|tally|notices)(\/|$)/.test(path)) return 'advanced_tax';
  if (/^\/api\/tax\/(audit-checks|audit-pack)(\/|$)/.test(path)) return 'audit';
  if (/^\/api\/(assistant|parse-manifest|bank\/parse-statement)(\/|$)/.test(path)) return 'ai';
  if (/^\/api\/team\/accountants(\/|$)/.test(path)) return 'outside_accountants';
  if (/^\/api\/practice(\/|$)/.test(path)) return 'practice';
  return null;
}

/** Practice tools belong to the accountant's own firm, so they follow the firm's plan, not the client's. */
export function featureUsesHomeCompany(feature: Feature): boolean {
  return feature === 'practice';
}
