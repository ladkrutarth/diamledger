import { z } from 'zod';
import type { DbPool } from '../core/db.js';
import type { CurrentUser, Role } from '../core/http.js';
import { bankLines, currentSuggestion } from '../modules/banking/bank.js';
import { parseMonth } from '../modules/tax/closedMonths.js';
import { filingSummary } from '../modules/tax/filing.js';
import { forexSummary } from '../modules/tax/forex.js';
import { realizationSummary } from '../modules/tax/realization.js';
import { DUE_DATE, listOverdue } from '../modules/collections/reminders.js';
import { exportRegister } from '../modules/tax/tax.js';
import { currentMonth, monthIsClosed } from '../modules/tax/taxShared.js';
import { complianceItems } from '../modules/accountant/workspace.js';

export type ToolContext = { pool: DbPool; user: CurrentUser; sessionId: string };

export type ToolSource = { kind: 'invoice' | 'buyer' | 'summary' | 'tax'; id?: string; label: string };

export type ActionKind = 'record_payment' | 'draft_reminder' | 'match_bank_line' | 'close_month';

export const TAX_READERS: Role[] = ['admin', 'tax', 'ca'];
export const BOOK_WRITERS: Role[] = ['admin', 'member', 'tax'];

/** Who may confirm each kind of proposal. */
export const CONFIRM_ROLES: Record<ActionKind, Role[]> = {
  record_payment: BOOK_WRITERS,
  draft_reminder: BOOK_WRITERS,
  match_bank_line: BOOK_WRITERS,
  close_month: ['ca'],
};

export function canUseTaxTools(user: CurrentUser): boolean {
  return TAX_READERS.includes(user.role);
}

export type ProposedAction = {
  id: string;
  kind: ActionKind;
  status: 'proposed' | 'confirmed' | 'rejected' | 'failed';
  payload: Record<string, unknown>;
  result?: unknown;
  createdAt: string;
};

export type ToolOutcome = { result: unknown; sources: ToolSource[]; action?: ProposedAction };

type Tool<S extends z.ZodType> = {
  name: string;
  description: string;
  args: S;
  roles?: Role[];
  run: (context: ToolContext, args: z.infer<S>) => Promise<ToolOutcome>;
};

type AnyTool = {
  name: string;
  description: string;
  args: z.ZodType;
  roles?: Role[];
  run: (context: ToolContext, args: never) => Promise<ToolOutcome>;
};

function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

function forModel(action: ProposedAction) {
  const { invoiceId: _internal, ...details } = action.payload;
  return { proposalId: action.id, status: 'awaiting_user_confirmation', ...details };
}

const MAX_ROWS = 20;
const invoiceNumber = z.string().trim().min(1).max(60).describe('Invoice number exactly as shown, e.g. XYZ/2026-27/004');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid date');
const month = z
  .string()
  .refine((value) => parseMonth(value) !== null, 'Use YYYY-MM')
  .describe('Calendar month, YYYY-MM');

const money = (value: number) => Math.round(value * 100) / 100;

type InvoiceRow = {
  id: string;
  invoice_number: string;
  status: string;
  buyer_name: string;
  destination_country: string;
  invoice_date: string | null;
  credit_days: number;
  due_date: string;
  days_overdue: number;
  total_usd: string;
  paid_usd: string;
};

const INVOICE_COLUMNS = `
  i.id, i.invoice_number, i.status, i.buyer_name, i.destination_country,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.credit_days,
  to_char(${DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - ${DUE_DATE} AS days_overdue,
  i.total_usd, COALESCE(p.paid, 0) AS paid_usd`;

const PAID_JOIN = 'LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true';

function compactInvoice(row: InvoiceRow) {
  const totalUsd = Number(row.total_usd);
  const paidUsd = Number(row.paid_usd);
  const dueUsd = Math.max(0, money(totalUsd - paidUsd));
  return {
    invoiceNumber: row.invoice_number,
    status: row.status,
    buyer: row.buyer_name,
    country: row.destination_country,
    invoiceDate: row.invoice_date,
    creditDays: row.credit_days,
    dueDate: row.due_date,
    overdue: row.status === 'issued' && dueUsd > 0 && Number(row.days_overdue) > 0,
    totalUsd,
    paidUsd,
    dueUsd,
  };
}

function invoiceSource(row: { id: string; invoice_number: string }): ToolSource {
  return { kind: 'invoice', id: row.id, label: row.invoice_number };
}

async function findInvoiceByNumber(context: ToolContext, number: string): Promise<InvoiceRow | undefined> {
  const result = await context.pool.query<InvoiceRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoices i ${PAID_JOIN}
     WHERE i.organization_id = $1 AND lower(i.invoice_number) = lower($2)`,
    [context.user.organizationId, number],
  );
  return result.rows[0];
}

export async function saveProposal(
  context: ToolContext,
  kind: ActionKind,
  payload: Record<string, unknown>,
): Promise<ProposedAction> {
  const result = await context.pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO assistant_actions (session_id, organization_id, kind, payload, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id, created_at`,
    [context.sessionId, context.user.organizationId, kind, JSON.stringify(payload), context.user.id],
  );
  return {
    id: result.rows[0].id,
    kind,
    status: 'proposed',
    payload,
    createdAt: new Date(result.rows[0].created_at).toISOString(),
  };
}

function refused(reason: string): ToolOutcome {
  return { result: { error: reason }, sources: [] };
}

const searchInvoices = defineTool({
  name: 'search_invoices',
  description: `Search the company's invoices by invoice number or buyer name, status, and invoice date range. Returns at most ${MAX_ROWS} invoices, newest first.`,
  args: z.object({
    query: z.string().trim().max(100).optional().describe('Part of an invoice number or buyer name'),
    status: z.enum(['draft', 'issued', 'paid', 'cancelled']).optional(),
    from: isoDate.optional().describe('Earliest invoice date, YYYY-MM-DD'),
    to: isoDate.optional().describe('Latest invoice date, YYYY-MM-DD'),
  }),
  async run(context, args) {
    const params: unknown[] = [context.user.organizationId];
    const where = ['i.organization_id = $1'];
    if (args.query) {
      params.push(`%${args.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      where.push(`(i.invoice_number ILIKE $${params.length} OR i.buyer_name ILIKE $${params.length})`);
    }
    if (args.status) {
      params.push(args.status);
      where.push(`i.status = $${params.length}`);
    }
    if (args.from) {
      params.push(args.from);
      where.push(`COALESCE(i.invoice_date, i.created_at::date) >= $${params.length}`);
    }
    if (args.to) {
      params.push(args.to);
      where.push(`COALESCE(i.invoice_date, i.created_at::date) <= $${params.length}`);
    }
    const result = await context.pool.query<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} FROM invoices i ${PAID_JOIN}
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(i.invoice_date, i.created_at::date) DESC, i.invoice_number DESC
       LIMIT ${MAX_ROWS + 1}`,
      params,
    );
    const rows = result.rows.slice(0, MAX_ROWS);
    return {
      result: { invoices: rows.map(compactInvoice), truncated: result.rows.length > MAX_ROWS },
      sources: rows.map(invoiceSource),
    };
  },
});

const getInvoice = defineTool({
  name: 'get_invoice',
  description: 'Get one invoice by its number, with its payments, reminder history, and line item summary.',
  args: z.object({ invoiceNumber }),
  async run(context, args) {
    const row = await findInvoiceByNumber(context, args.invoiceNumber);
    if (!row) return refused(`No invoice numbered ${args.invoiceNumber} was found.`);
    const [details, payments, reminders] = await Promise.all([
      context.pool.query<{ items: number; carats: string; email: string | null; contact: string | null }>(
        `SELECT jsonb_array_length(COALESCE(data->'items', '[]'::jsonb)) AS items, total_carats AS carats,
                data->'consignee'->>'email' AS email, data->'consignee'->>'contactPerson' AS contact
         FROM invoices WHERE id = $1`,
        [row.id],
      ),
      context.pool.query<{ amount_usd: string; paid_on: string; reference: string }>(
        `SELECT amount_usd, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference
         FROM payments WHERE invoice_id = $1 ORDER BY paid_on, created_at`,
        [row.id],
      ),
      context.pool.query<{ status: string; sent_at: Date | null; created_at: Date }>(
        `SELECT status, sent_at, created_at FROM payment_reminders
         WHERE invoice_id = $1 AND status IN ('draft', 'sent') ORDER BY created_at`,
        [row.id],
      ),
    ]);
    const detail = details.rows[0];
    return {
      result: {
        ...compactInvoice(row),
        buyerContact: detail.contact ?? '',
        buyerEmail: detail.email ?? '',
        lineItems: Number(detail.items),
        totalCarats: Number(detail.carats),
        payments: payments.rows.map((payment) => ({
          amountUsd: Number(payment.amount_usd),
          paidOn: payment.paid_on,
          reference: payment.reference,
        })),
        reminders: reminders.rows.map((reminder) => ({
          status: reminder.status,
          date: new Date(reminder.sent_at ?? reminder.created_at).toISOString().slice(0, 10),
        })),
      },
      sources: [invoiceSource(row)],
    };
  },
});

const listOverdueTool = defineTool({
  name: 'list_overdue',
  description: `List issued invoices that are past their due date and still have money owed, most overdue first. At most ${MAX_ROWS}.`,
  args: z.object({}),
  async run(context) {
    const overdue = await listOverdue(context.pool, context.user.organizationId);
    const rows = overdue.slice(0, MAX_ROWS);
    return {
      result: {
        invoices: rows.map((invoice) => ({
          invoiceNumber: invoice.invoiceNumber,
          buyer: invoice.buyerName,
          dueDate: invoice.dueDate,
          daysOverdue: invoice.daysOverdue,
          totalUsd: invoice.totalUsd,
          paidUsd: invoice.paidUsd,
          dueUsd: invoice.dueUsd,
          remindersSent: invoice.remindersSent,
          remindedInLastWeek: invoice.recentlyReminded,
        })),
        count: overdue.length,
        truncated: overdue.length > MAX_ROWS,
      },
      sources: rows.map((invoice) => ({ kind: 'invoice' as const, id: invoice.id, label: invoice.invoiceNumber })),
    };
  },
});

const unpaidSummary = defineTool({
  name: 'unpaid_summary',
  description: 'Total money still owed on issued invoices, split into overdue and not yet due, with a per-buyer breakdown. Optionally limit to buyers whose name contains the given text.',
  args: z.object({ buyer: z.string().trim().max(100).optional().describe('Part of a buyer name') }),
  async run(context, args) {
    const params: unknown[] = [context.user.organizationId];
    let buyerFilter = '';
    if (args.buyer) {
      params.push(`%${args.buyer.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      buyerFilter = `AND i.buyer_name ILIKE $${params.length}`;
    }
    const result = await context.pool.query<{
      buyer_name: string; invoices: string; due_usd: string; overdue_usd: string; overdue_invoices: string;
    }>(
      `SELECT i.buyer_name, COUNT(*) AS invoices,
              SUM(i.total_usd - COALESCE(p.paid, 0)) AS due_usd,
              SUM(CASE WHEN ${DUE_DATE} < current_date THEN i.total_usd - COALESCE(p.paid, 0) ELSE 0 END) AS overdue_usd,
              COUNT(*) FILTER (WHERE ${DUE_DATE} < current_date) AS overdue_invoices
       FROM invoices i ${PAID_JOIN}
       WHERE i.organization_id = $1 AND i.status = 'issued' AND i.total_usd - COALESCE(p.paid, 0) > 0 ${buyerFilter}
       GROUP BY i.buyer_name
       ORDER BY due_usd DESC`,
      params,
    );
    const buyers = result.rows.map((row) => ({
      buyer: row.buyer_name,
      unpaidInvoices: Number(row.invoices),
      dueUsd: money(Number(row.due_usd)),
      overdueInvoices: Number(row.overdue_invoices),
      overdueUsd: money(Number(row.overdue_usd)),
    }));
    const totalDueUsd = money(buyers.reduce((sum, buyer) => sum + buyer.dueUsd, 0));
    const overdueUsd = money(buyers.reduce((sum, buyer) => sum + buyer.overdueUsd, 0));
    return {
      result: {
        totalDueUsd,
        overdueUsd,
        notYetDueUsd: money(totalDueUsd - overdueUsd),
        unpaidInvoices: buyers.reduce((sum, buyer) => sum + buyer.unpaidInvoices, 0),
        buyers: buyers.slice(0, MAX_ROWS),
      },
      sources: [{ kind: 'summary', label: args.buyer ? `Unpaid invoices for "${args.buyer}"` : 'All unpaid invoices' }],
    };
  },
});

const findBuyer = defineTool({
  name: 'find_buyer',
  description: 'Look up saved buyers whose name contains the given text. Returns their country, contact person, and email.',
  args: z.object({ name: z.string().trim().min(1).max(100) }),
  async run(context, args) {
    const result = await context.pool.query<{ id: string; name: string; data: Record<string, string> }>(
      `SELECT id, name, data FROM buyers
       WHERE organization_id = $1 AND name ILIKE $2
       ORDER BY lower(name) LIMIT ${MAX_ROWS}`,
      [context.user.organizationId, `%${args.name.replace(/[\\%_]/g, (char) => `\\${char}`)}%`],
    );
    return {
      result: {
        buyers: result.rows.map((row) => ({
          name: row.name,
          city: row.data.city ?? '',
          country: row.data.country ?? '',
          contactPerson: row.data.contactPerson ?? '',
          email: row.data.email ?? '',
        })),
      },
      sources: result.rows.map((row) => ({ kind: 'buyer' as const, id: row.id, label: row.name })),
    };
  },
});

const proposePayment = defineTool({
  name: 'propose_payment',
  description: 'Propose recording a payment received against an issued invoice. Nothing is saved until the user confirms the proposal in the app.',
  roles: BOOK_WRITERS,
  args: z.object({
    invoiceNumber,
    amountUsd: z.number().positive().max(1e11).describe('Amount received in USD'),
    paidOn: isoDate.optional().describe('Date the money arrived, YYYY-MM-DD. Defaults to today.'),
    reference: z.string().trim().max(200).optional().describe('Bank or SWIFT reference'),
  }),
  async run(context, args) {
    const row = await findInvoiceByNumber(context, args.invoiceNumber);
    if (!row) return refused(`No invoice numbered ${args.invoiceNumber} was found.`);
    const invoice = compactInvoice(row);
    if (row.status !== 'issued') {
      return { ...refused(`Invoice ${row.invoice_number} is ${row.status}; payments can only be recorded on issued invoices.`), sources: [invoiceSource(row)] };
    }
    const amountUsd = money(args.amountUsd);
    if (amountUsd > invoice.dueUsd) {
      return {
        ...refused(`${amountUsd} USD is more than the ${invoice.dueUsd} USD still due on ${row.invoice_number}.`),
        sources: [invoiceSource(row)],
      };
    }
    const action = await saveProposal(context, 'record_payment', {
      invoiceId: row.id,
      invoiceNumber: row.invoice_number,
      buyer: row.buyer_name,
      amountUsd,
      paidOn: args.paidOn ?? new Date().toISOString().slice(0, 10),
      reference: args.reference ?? '',
      dueUsdAtProposal: invoice.dueUsd,
      paidUsdAtProposal: invoice.paidUsd,
    });
    return {
      result: forModel(action),
      sources: [invoiceSource(row)],
      action,
    };
  },
});

const proposeReminder = defineTool({
  name: 'propose_reminder',
  description: 'Propose drafting a payment reminder email for an overdue invoice. On confirmation a draft is created on the Follow-ups page; no email is sent.',
  roles: BOOK_WRITERS,
  args: z.object({ invoiceNumber }),
  async run(context, args) {
    const row = await findInvoiceByNumber(context, args.invoiceNumber);
    if (!row) return refused(`No invoice numbered ${args.invoiceNumber} was found.`);
    const overdue = (await listOverdue(context.pool, context.user.organizationId)).find((invoice) => invoice.id === row.id);
    if (!overdue) {
      return { ...refused(`Invoice ${row.invoice_number} is not overdue, so no reminder is needed.`), sources: [invoiceSource(row)] };
    }
    const action = await saveProposal(context, 'draft_reminder', {
      invoiceId: row.id,
      invoiceNumber: row.invoice_number,
      buyer: overdue.buyerName,
      dueUsd: overdue.dueUsd,
      daysOverdue: overdue.daysOverdue,
      remindedInLastWeek: overdue.recentlyReminded,
      paidUsdAtProposal: overdue.paidUsd,
    });
    return {
      result: forModel(action),
      sources: [invoiceSource(row)],
      action,
    };
  },
});

const TAX_SOURCE = (label: string): ToolSource => ({ kind: 'tax', label });

const complianceCalendar = defineTool({
  name: 'compliance_calendar',
  description: 'List the company\'s tax deadlines and open compliance tasks: GSTR-1, GSTR-3B, LUT renewal, FEMA realization, ITC refund windows, and filing problems. Each item has a status and days left.',
  roles: TAX_READERS,
  args: z.object({}),
  async run(context) {
    const items = await complianceItems(
      context.pool,
      { id: context.user.organizationId, name: context.user.organizationName },
      new Date(),
    );
    return {
      result: {
        items: items.map(({ kind, title, dueDate, daysLeft, status, detail }) => ({ kind, title, dueDate, daysLeft, status, detail })),
      },
      sources: [TAX_SOURCE('Compliance calendar')],
    };
  },
});

const filingCheck = defineTool({
  name: 'filing_check',
  description: `Check whether a month's issued export invoices are ready for GSTR-1 table 6A and e-invoicing. Returns ready and problem counts, company-level problems, and the problems on at most ${MAX_ROWS} invoices.`,
  roles: TAX_READERS,
  args: z.object({ month: month.optional().describe('Calendar month, YYYY-MM. Defaults to this month.') }),
  async run(context, args) {
    const target = args.month ?? currentMonth();
    const { rows, companyIssues, settings } = await filingSummary(context.pool, context.user.organizationId, target);
    const problems = rows.filter((row) => !row.ready);
    const shown = problems.slice(0, MAX_ROWS);
    return {
      result: {
        month: target,
        einvoiceRequired: settings.einvoiceRequired,
        invoiceCount: rows.length,
        readyCount: rows.length - problems.length,
        issueCount: problems.length,
        companyIssues: companyIssues.map((issue) => issue.message),
        invoicesWithIssues: shown.map((row) => ({
          invoiceNumber: row.invoiceNumber,
          invoiceDate: row.invoiceDate,
          issues: row.issues.map((issue) => issue.message),
        })),
        truncated: problems.length > MAX_ROWS,
      },
      sources: [TAX_SOURCE(`Filing check ${target}`), ...shown.map((row) => ({ kind: 'invoice' as const, id: row.id, label: row.invoiceNumber }))],
    };
  },
});

const exportRegisterTool = defineTool({
  name: 'export_register',
  description: `The export register for a month: invoice count, taxable value and IGST in USD, whether the books for the month are closed, and at most ${MAX_ROWS} invoices.`,
  roles: TAX_READERS,
  args: z.object({ month: month.optional().describe('Calendar month, YYYY-MM. Defaults to this month.') }),
  async run(context, args) {
    const target = args.month ?? currentMonth();
    const register = await exportRegister(context.pool, context.user.organizationId, target);
    const shown = register.rows.slice(0, MAX_ROWS);
    return {
      result: {
        month: target,
        closed: register.closed,
        count: register.totals.count,
        taxableUsd: register.totals.taxableUsd,
        igstUsd: register.totals.igstUsd,
        invoices: shown.map((row) => ({
          invoiceNumber: row.invoiceNumber,
          invoiceDate: row.invoiceDate,
          buyer: row.buyerName,
          status: row.status,
          scheme: row.exportScheme,
          taxableUsd: row.taxableUsd,
          igstUsd: row.igstUsd,
          shippingBillNo: row.shippingBillNo,
          caReview: row.reviewStatus ?? 'none',
        })),
        truncated: register.rows.length > MAX_ROWS,
      },
      sources: [TAX_SOURCE(`Export register ${target}`), ...shown.map((row) => ({ kind: 'invoice' as const, id: row.id, label: row.invoiceNumber }))],
    };
  },
});

const realizationWatch = defineTool({
  name: 'realization_watch',
  description: `FEMA export realization status: how many invoices are still unrealized, the USD still to be received, how many are past or near the deadline, and at most ${MAX_ROWS} urgent invoices.`,
  roles: TAX_READERS,
  args: z.object({}),
  async run(context) {
    const summary = await realizationSummary(context.pool, context.user.organizationId);
    const urgent = summary.rows.filter((row) => row.flag === 'overdue' || row.flag === 'due_soon');
    const shown = urgent.slice(0, MAX_ROWS);
    return {
      result: {
        realizationMonths: summary.realizationMonths,
        openCount: summary.openCount,
        openUsd: summary.openUsd,
        overdueCount: summary.overdueCount,
        dueSoonCount: summary.dueSoonCount,
        needsBrcCount: summary.needsBrcCount,
        urgent: shown.map((row) => ({
          invoiceNumber: row.invoiceNumber,
          buyer: row.buyerName,
          shippedOn: row.shippedOn,
          deadline: row.deadline,
          daysLeft: row.daysLeft,
          dueUsd: row.dueUsd,
          flag: row.flag,
        })),
        truncated: urgent.length > MAX_ROWS,
      },
      sources: [TAX_SOURCE('Realization watch'), ...shown.map((row) => ({ kind: 'invoice' as const, id: row.id, label: row.invoiceNumber }))],
    };
  },
});

const forexSummaryTool = defineTool({
  name: 'forex_summary',
  description: `Foreign exchange gain or loss in INR on payments received in a month, comparing the bank rate with the invoice rate. Returns totals, how many payments lack a bank rate, and at most ${MAX_ROWS} payments.`,
  roles: TAX_READERS,
  args: z.object({ month: month.optional().describe('Calendar month, YYYY-MM. Defaults to this month.') }),
  async run(context, args) {
    const target = args.month ?? currentMonth();
    const summary = await forexSummary(context.pool, context.user.organizationId, target);
    const shown = summary.rows.slice(0, MAX_ROWS);
    return {
      result: {
        month: target,
        paymentCount: summary.rows.length,
        missingRateCount: summary.missingRateCount,
        gainInr: summary.totals.gainInr,
        lossInr: summary.totals.lossInr,
        netInr: summary.totals.netInr,
        payments: shown.map((row) => ({
          invoiceNumber: row.invoiceNumber,
          paidOn: row.paidOn,
          amountUsd: row.amountUsd,
          invoiceRateInr: row.invoiceRateInr,
          bankRateInr: row.bankRateInr,
          gainInr: row.gainInr,
        })),
        truncated: summary.rows.length > MAX_ROWS,
      },
      sources: [TAX_SOURCE(`Forex ${target}`), ...shown.map((row) => ({ kind: 'invoice' as const, id: row.invoiceId, label: row.invoiceNumber }))],
    };
  },
});

const bankMatches = defineTool({
  name: 'bank_matches',
  description: `List imported bank credits that are not yet matched to an invoice, newest first, at most ${MAX_ROWS}. Each line has the best invoice the matcher suggests, with a score out of 100 and its reasons.`,
  roles: TAX_READERS,
  args: z.object({}),
  async run(context) {
    const lines = await bankLines(context.pool, context.user.organizationId, 'unmatched', MAX_ROWS + 1);
    const shown = lines.slice(0, MAX_ROWS);
    return {
      result: {
        lines: shown.map((line) => {
          const best = line.suggestions[0];
          return {
            lineId: line.id,
            date: line.lineDate,
            amountUsd: line.amountUsd,
            reference: line.reference,
            narration: line.narration,
            suggestion: best
              ? { invoiceNumber: best.invoiceNumber, buyer: best.buyerName, dueUsd: best.dueUsd, score: best.score, reasons: best.reasons }
              : null,
          };
        }),
        truncated: lines.length > MAX_ROWS,
      },
      sources: [TAX_SOURCE('Unmatched bank lines')],
    };
  },
});

export type BankMatchProposal = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

/** Builds a bank-match proposal only when the matcher itself links this line to this invoice. */
export async function bankMatchProposal(pool: DbPool, organizationId: string, lineId: string, invoiceId: string): Promise<BankMatchProposal> {
  const suggestion = await currentSuggestion(pool, organizationId, lineId, invoiceId);
  if (!suggestion) {
    return { ok: false, error: 'The matcher does not suggest that invoice for this bank line, or the line is already dealt with.' };
  }
  const details = await pool.query<{ line_date: string; amount_usd: string; reference: string; status: string; paid: string }>(
    `SELECT to_char(b.line_date, 'YYYY-MM-DD') AS line_date, b.amount_usd, b.reference, i.status,
            COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid
     FROM bank_lines b JOIN invoices i ON i.id = $3 AND i.organization_id = b.organization_id
     WHERE b.id = $1 AND b.organization_id = $2`,
    [lineId, organizationId, invoiceId],
  );
  const row = details.rows[0];
  if (!row) return { ok: false, error: 'Bank line not found.' };
  return {
    ok: true,
    payload: {
      lineId,
      invoiceId,
      invoiceNumber: suggestion.invoiceNumber,
      buyer: suggestion.buyerName,
      amountUsd: money(Number(row.amount_usd)),
      lineDate: row.line_date,
      reference: row.reference,
      score: suggestion.score,
      reasons: suggestion.reasons,
      dueUsdAtProposal: suggestion.dueUsd,
      paidUsdAtProposal: money(Number(row.paid)),
    },
  };
}

export type CloseCheck =
  | { ok: true; invoiceCount: number }
  | { ok: false; error: string };

/** A month can be closed once it has ended, is still open, and its filing check is clean. */
export async function monthCloseCheck(pool: DbPool, organizationId: string, target: string): Promise<CloseCheck> {
  if (target >= currentMonth()) return { ok: false, error: `${target} has not ended yet, so its books cannot be closed.` };
  if (await monthIsClosed(pool, organizationId, target)) return { ok: false, error: `The books for ${target} are already closed.` };
  const { rows, companyIssues } = await filingSummary(pool, organizationId, target);
  const problems = rows.filter((row) => !row.ready).length;
  if (problems || companyIssues.length) {
    const parts = [
      problems ? `${problems} invoice${problems === 1 ? ' has' : 's have'} filing problems` : '',
      companyIssues.length ? 'the company GSTIN needs fixing' : '',
    ].filter(Boolean);
    return { ok: false, error: `${target} cannot be closed yet: ${parts.join(' and ')}. Run the filing check for details.` };
  }
  return { ok: true, invoiceCount: rows.length };
}

const proposeBankMatch = defineTool({
  name: 'propose_bank_match',
  description: 'Propose matching an unmatched bank credit to the invoice the matcher suggests for it. On confirmation the payment is recorded and the line is marked matched. Use a lineId from bank_matches.',
  roles: ['admin', 'tax'],
  args: z.object({
    lineId: z.string().uuid().describe('lineId from bank_matches'),
    invoiceNumber,
  }),
  async run(context, args) {
    const row = await findInvoiceByNumber(context, args.invoiceNumber);
    if (!row) return refused(`No invoice numbered ${args.invoiceNumber} was found.`);
    const proposal = await bankMatchProposal(context.pool, context.user.organizationId, args.lineId, row.id);
    if (!proposal.ok) return { ...refused(proposal.error), sources: [invoiceSource(row)] };
    const action = await saveProposal(context, 'match_bank_line', proposal.payload);
    return { result: forModel(action), sources: [invoiceSource(row)], action };
  },
});

const proposeCloseMonth = defineTool({
  name: 'propose_close_month',
  description: 'Propose closing the books for a month that has ended and whose filing check is clean. Once closed, invoices and payments in that month cannot change until a chartered accountant reopens it.',
  roles: ['ca'],
  args: z.object({ month }),
  async run(context, args) {
    const check = await monthCloseCheck(context.pool, context.user.organizationId, args.month);
    if (!check.ok) return { ...refused(check.error), sources: [TAX_SOURCE(`Filing check ${args.month}`)] };
    const action = await saveProposal(context, 'close_month', { month: args.month, invoiceCount: check.invoiceCount });
    return { result: forModel(action), sources: [TAX_SOURCE(`Filing check ${args.month}`)], action };
  },
});

export const TOOLS: AnyTool[] = [
  searchInvoices,
  getInvoice,
  listOverdueTool,
  unpaidSummary,
  findBuyer,
  proposePayment,
  proposeReminder,
  complianceCalendar,
  filingCheck,
  exportRegisterTool,
  realizationWatch,
  forexSummaryTool,
  bankMatches,
  proposeBankMatch,
  proposeCloseMonth,
];

export type ToolDeclaration = { name: string; description: string; parametersJsonSchema: unknown };

function allowed(tool: AnyTool, user: CurrentUser): boolean {
  return !tool.roles || tool.roles.includes(user.role);
}

export function toolDeclarations(user: CurrentUser): ToolDeclaration[] {
  return TOOLS.filter((tool) => allowed(tool, user)).map((tool) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.args) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
  });
}

export async function runTool(context: ToolContext, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return refused(`There is no tool named ${name}.`);
  if (!allowed(tool, context.user)) return refused(`Your role (${context.user.role}) cannot use ${name}.`);
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return refused(`Invalid arguments for ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`);
  }
  return tool.run(context, parsed.data as never);
}
