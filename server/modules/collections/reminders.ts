import type { Express } from 'express';
import { Type } from '@google/genai';
import { z } from 'zod';
import type { DbPool } from '../../core/db.js';
import {
  dispatchEmail,
  InputError,
  parseEmailRequest,
  type CreateMailTransport,
} from './emailDispatch.js';
import { callModel, usageFrom, type TokenUsage } from '../../ai/call.js';
import { GEMINI_MODEL, activeModelName, aiProvider, gemini } from '../../ai/client.js';
import { hfReminderText } from '../../ai/huggingface.js';
import { asyncHandler, currentUser, isRecord, isUuid, requireUser, type CurrentUser } from '../../core/http.js';
import type { StoredInvoice } from '../invoices/invoiceValidation.js';

export const REMINDER_PROMPT_VERSION = 'reminder-v1';
const REPEAT_WINDOW_DAYS = 7;

export type ReminderTone = 'gentle' | 'firm' | 'final';

export type ReminderPromptFacts = {
  buyerName: string;
  contactPerson: string;
  exporterName: string;
  tone: ReminderTone;
};

export type ReminderText = { subject: string; greeting: string; paragraphs: string[] };

export type DraftReminderText = (
  facts: ReminderPromptFacts,
  signal?: AbortSignal,
) => Promise<ReminderText & { usage?: TokenUsage }>;

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

const SYSTEM_PROMPT = `You write short, courteous payment reminder emails for a diamond exporter writing to an overseas buyer.
Write only the wording. The invoice number, amounts, dates, and bank details are added to the email by the system below your text.
Never write any digits, amounts, currencies, dates, account numbers, or invoice numbers. Refer to "the invoice" and "the outstanding balance" instead.
Match the requested tone: gentle is a friendly nudge, firm asks for payment or a payment date this week, final says further reminders will be followed by a call from the accounts team.
Keep it professional and brief: one to three short paragraphs, no sign-off (the system adds it).`;

const modelText = (max: number) =>
  z.string().trim().min(1).max(max).refine((value) => !/\d/.test(value), 'Model text must not contain figures');

const reminderTextSchema = z.object({
  subject: modelText(120),
  greeting: modelText(200),
  paragraphs: z.array(modelText(800)).min(1).max(4),
});

export const geminiReminderText: DraftReminderText = async (facts, signal) => {
  const response = await gemini().models.generateContent({
    model: GEMINI_MODEL,
    contents: {
      parts: [{
        text: `Tone: ${facts.tone}\nBuyer company: ${facts.buyerName || 'not given'}\n`
          + `Buyer contact person: ${facts.contactPerson || 'not given'}\nExporter company: ${facts.exporterName || 'not given'}`,
      }],
    },
    config: {
      abortSignal: signal,
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: 'Email subject line without any invoice number' },
          greeting: { type: Type.STRING, description: 'Opening line, e.g. Dear Mr. Peeters,' },
          paragraphs: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['subject', 'greeting', 'paragraphs'],
      },
    },
  });
  return { ...JSON.parse(response.text || '{}'), usage: usageFrom(response.usageMetadata) };
};

/** The reminder drafter for the configured AI_PROVIDER. */
export const defaultReminderText: DraftReminderText = (facts, signal) =>
  aiProvider() === 'huggingface' ? hfReminderText(SYSTEM_PROMPT)(facts, signal) : geminiReminderText(facts, signal);

export function reminderTone(daysOverdue: number, remindersSent: number): ReminderTone {
  if (remindersSent >= 2 || daysOverdue > 60) return 'final';
  if (remindersSent >= 1 || daysOverdue > 21) return 'firm';
  return 'gentle';
}

export function templateReminderText(facts: ReminderPromptFacts): ReminderText {
  const opening = {
    gentle: 'We hope you are well. Our records show that the invoice below has not yet been paid in full and is now past its due date.',
    firm: 'We are following up on the invoice below, which remains unpaid past its due date despite our earlier reminder.',
    final: 'Despite our earlier reminders, the invoice below is still outstanding. We would ask you to treat this as a priority.',
  }[facts.tone];
  return {
    subject: 'Payment reminder',
    greeting: `Dear ${facts.contactPerson || facts.buyerName || 'Sir or Madam'},`,
    paragraphs: [
      opening,
      'Please arrange payment of the outstanding balance to the bank account below, or let us know the date payment will be made if it is already on its way.',
      'Thank you for your continued business.',
    ],
  };
}

export async function draftText(
  produce: () => Promise<unknown>,
  facts: ReminderPromptFacts,
): Promise<{ text: ReminderText; source: 'model' | 'template' }> {
  try {
    const parsed = reminderTextSchema.safeParse(await produce());
    if (parsed.success) return { text: parsed.data, source: 'model' };
    console.warn('Reminder draft rejected:', parsed.error.issues[0]?.message);
  } catch (error) {
    console.warn('Reminder draft failed:', (error as Error).message);
  }
  return { text: templateReminderText(facts), source: 'template' };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function reminderSubject(subject: string, invoiceNumber: string): string {
  return `${subject.replace(/[\r\n]+/g, ' ').trim()} - Invoice ${invoiceNumber}`;
}

export function renderReminderHtml(text: ReminderText, figures: ReminderFigures): string {
  const cell = 'padding: 4px 12px 4px 0; vertical-align: top;';
  const row = (label: string, value: string) =>
    value ? `<tr><td style="${cell} color: #64748b;">${escapeHtml(label)}</td><td style="${cell} font-weight: 600;">${escapeHtml(value)}</td></tr>` : '';
  const paragraphs = text.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n');
  const { bank } = figures;
  const signature = [figures.signatoryName, figures.signatoryDesignation, figures.exporterName].filter(Boolean).map(escapeHtml);

  return `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; max-width: 650px; line-height: 1.6;">
<p>${escapeHtml(text.greeting)}</p>
${paragraphs}
<table style="border-collapse: collapse; margin: 12px 0;">
${row('Invoice number', figures.invoiceNumber)}
${row('Invoice date', figures.invoiceDate ?? '')}
${row('Due date', figures.dueDate)}
${row('Invoice total', usd(figures.totalUsd))}
${row('Received', usd(figures.paidUsd))}
${row('Balance due', usd(figures.dueUsd))}
${row('Payment terms', figures.paymentTerms)}
</table>
<table style="border-collapse: collapse; margin: 12px 0;">
${row('Bank', bank.bankName)}
${row('Account number', bank.accountNumber)}
${row('SWIFT', bank.swiftCode)}
${row('IBAN', bank.iban)}
</table>
<p>Kind regards,<br />${signature.join('<br />')}</p>
</div>`;
}

type InvoiceForReminder = {
  id: string;
  invoice_number: string;
  status: string;
  data: StoredInvoice;
  invoice_date: string | null;
  due_date: string;
  days_overdue: number;
  total_usd: string;
  paid_usd: string;
  sent_count: string;
  last_sent_at: Date | null;
};

export const DUE_DATE = '(COALESCE(i.invoice_date, i.created_at::date) + i.credit_days)';

async function loadInvoiceForReminder(pool: DbPool, invoiceId: string, organizationId: string) {
  if (!isUuid(invoiceId)) return undefined;
  const result = await pool.query<InvoiceForReminder>(
    `SELECT i.id, i.invoice_number, i.status, i.data, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            to_char(${DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - ${DUE_DATE} AS days_overdue,
            i.total_usd,
            COALESCE((SELECT SUM(p.amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_usd,
            (SELECT COUNT(*) FROM payment_reminders r WHERE r.invoice_id = i.id AND r.status = 'sent') AS sent_count,
            (SELECT MAX(r.sent_at) FROM payment_reminders r WHERE r.invoice_id = i.id AND r.status = 'sent') AS last_sent_at
     FROM invoices i WHERE i.id = $1 AND i.organization_id = $2`,
    [invoiceId, organizationId],
  );
  return result.rows[0];
}

function toFigures(row: InvoiceForReminder): ReminderFigures {
  const totalUsd = Number(row.total_usd);
  const paidUsd = Number(row.paid_usd);
  const data = row.data;
  return {
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    daysOverdue: Number(row.days_overdue),
    totalUsd,
    paidUsd,
    dueUsd: Math.max(0, Math.round((totalUsd - paidUsd) * 100) / 100),
    paymentTerms: data.shipment?.paymentTerms ?? '',
    exporterName: data.exporter?.companyName ?? '',
    signatoryName: data.authorizedSignatoryName ?? '',
    signatoryDesignation: data.authorizedSignatoryDesignation ?? '',
    bank: {
      bankName: data.bank?.bankName ?? '',
      accountNumber: data.bank?.accountNumber ?? '',
      swiftCode: data.bank?.swiftCode ?? '',
      iban: data.bank?.iban ?? '',
    },
  };
}

function recentlyReminded(lastSentAt: Date | null): boolean {
  return Boolean(lastSentAt) && Date.now() - new Date(lastSentAt as Date).getTime() < REPEAT_WINDOW_DAYS * 86_400_000;
}

function cannotRemind(row: InvoiceForReminder, figures: ReminderFigures): string | null {
  if (row.status !== 'issued') return `This invoice is ${row.status}, so no reminder is needed.`;
  if (figures.dueUsd <= 0) return 'This invoice has no balance due.';
  return null;
}

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

export async function listOverdue(pool: DbPool, organizationId: string): Promise<OverdueInvoice[]> {
  const result = await pool.query<{
    id: string; invoice_number: string; buyer_name: string; buyer_email: string | null; invoice_date: string | null;
    due_date: string; days_overdue: number; total_usd: string; paid_usd: string; sent_count: string; last_sent_at: Date | null;
  }>(
    `SELECT i.id, i.invoice_number, i.buyer_name, i.data->'consignee'->>'email' AS buyer_email,
            to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            to_char(${DUE_DATE}, 'YYYY-MM-DD') AS due_date, current_date - ${DUE_DATE} AS days_overdue,
            i.total_usd, COALESCE(p.paid, 0) AS paid_usd,
            COALESCE(r.sent_count, 0) AS sent_count, r.last_sent_at
     FROM invoices i
     LEFT JOIN LATERAL (SELECT SUM(amount_usd) AS paid FROM payments WHERE invoice_id = i.id) p ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS sent_count, MAX(sent_at) AS last_sent_at
       FROM payment_reminders WHERE invoice_id = i.id AND status = 'sent'
     ) r ON true
     WHERE i.organization_id = $1 AND i.status = 'issued'
       AND ${DUE_DATE} < current_date
       AND i.total_usd - COALESCE(p.paid, 0) > 0
     ORDER BY days_overdue DESC, i.invoice_number`,
    [organizationId],
  );
  return result.rows.map((row) => {
    const totalUsd = Number(row.total_usd);
    const paidUsd = Number(row.paid_usd);
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      buyerName: row.buyer_name,
      buyerEmail: row.buyer_email ?? '',
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      daysOverdue: Number(row.days_overdue),
      totalUsd,
      paidUsd,
      dueUsd: Math.max(0, Math.round((totalUsd - paidUsd) * 100) / 100),
      remindersSent: Number(row.sent_count),
      lastReminderAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
      recentlyReminded: recentlyReminded(row.last_sent_at),
    };
  });
}

export type ReminderDraftResult =
  | { ok: true; draft: Record<string, unknown> & { id: string } }
  | { ok: false; status: 404 | 409; error: string; recentlyReminded?: boolean };

export async function createReminderDraft(
  pool: DbPool,
  user: CurrentUser,
  drafter: DraftReminderText,
  invoiceId: string,
  options: { confirmRepeat?: boolean } = {},
): Promise<ReminderDraftResult> {
  const row = await loadInvoiceForReminder(pool, invoiceId, user.organizationId);
  if (!row) {
    return { ok: false, status: 404, error: 'Invoice not found.' };
  }
  const figures = toFigures(row);
  const blocked = cannotRemind(row, figures);
  if (blocked) {
    return { ok: false, status: 409, error: blocked };
  }
  if (recentlyReminded(row.last_sent_at) && !options.confirmRepeat) {
    return {
      ok: false,
      status: 409,
      error: `A reminder for this invoice was sent in the last ${REPEAT_WINDOW_DAYS} days. Confirm to draft another.`,
      recentlyReminded: true,
    };
  }

  const remindersSent = Number(row.sent_count);
  const promptFacts: ReminderPromptFacts = {
    buyerName: row.data.consignee?.companyName ?? '',
    contactPerson: row.data.consignee?.contactPerson ?? '',
    exporterName: figures.exporterName,
    tone: reminderTone(figures.daysOverdue, remindersSent),
  };
  const { text, source } = await draftText(
    () =>
      callModel(
        pool,
        {
          feature: 'payment_reminder',
          promptVersion: REMINDER_PROMPT_VERSION,
          model: activeModelName(),
          organizationId: user.organizationId,
          userId: user.id,
        },
        async (signal) => {
          const { usage, ...value } = await drafter(promptFacts, signal);
          return { value, usage };
        },
      ),
    promptFacts,
  );
  const subject = reminderSubject(text.subject, figures.invoiceNumber);
  const html = renderReminderHtml(text, figures);

  const inserted = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO payment_reminders (organization_id, invoice_id, created_by, model, prompt_version, subject, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [user.organizationId, row.id, user.id, source === 'model' ? activeModelName() : 'template', REMINDER_PROMPT_VERSION,
      subject, html],
  );
  console.info(JSON.stringify({
    event: 'reminder_drafted',
    source,
    tone: promptFacts.tone,
    organizationId: user.organizationId,
    invoiceNumber: figures.invoiceNumber,
  }));

  return {
    ok: true,
    draft: {
      id: inserted.rows[0].id,
      invoiceId: row.id,
      status: 'draft',
      source,
      tone: promptFacts.tone,
      subject: text.subject,
      greeting: text.greeting,
      paragraphs: text.paragraphs,
      fullSubject: subject,
      html,
      recipients: row.data.consignee?.email ? [row.data.consignee.email] : [],
      phone: typeof row.data.consignee?.phone === 'string' ? row.data.consignee.phone : '',
      figures,
      createdAt: new Date(inserted.rows[0].created_at).toISOString(),
    },
  };
}

const editedText = z.object({
  subject: z.string().trim().min(1, 'Subject is required.').max(200, 'Subject is too long.'),
  greeting: z.string().trim().min(1, 'Greeting is required.').max(300, 'Greeting is too long.'),
  paragraphs: z.array(z.string().trim().max(2000, 'A paragraph is too long.')).max(10, 'Use at most 10 paragraphs.'),
});

export function registerReminderRoutes(
  app: Express,
  pool: DbPool,
  drafter: DraftReminderText,
  createTransport: CreateMailTransport,
): void {
  app.get('/api/reminders/overdue', requireUser, asyncHandler(async (_req, res) => {
    return res.json({ invoices: await listOverdue(pool, currentUser(res).organizationId) });
  }));

  app.post('/api/reminders/draft', requireUser, asyncHandler(async (req, res) => {
    const invoiceId = typeof req.body?.invoiceId === 'string' ? req.body.invoiceId : '';
    const result = await createReminderDraft(pool, currentUser(res), drafter, invoiceId, {
      confirmRepeat: req.body?.confirmRepeat === true,
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.recentlyReminded ? { recentlyReminded: true } : {}),
      });
    }
    return res.status(201).json(result.draft);
  }));

  app.post('/api/reminders/:id/send', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Reminder not found.' });
    }
    const reminder = await pool.query<{ id: string; invoice_id: string; status: string }>(
      'SELECT id, invoice_id, status FROM payment_reminders WHERE id = $1 AND organization_id = $2',
      [req.params.id, user.organizationId],
    );
    const found = reminder.rows[0];
    if (!found) {
      return res.status(404).json({ error: 'Reminder not found.' });
    }
    if (found.status !== 'draft') {
      return res.status(409).json({ error: `This reminder was already ${found.status}.` });
    }

    const row = await loadInvoiceForReminder(pool, found.invoice_id, user.organizationId);
    if (!row) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const figures = toFigures(row);
    const blocked = cannotRemind(row, figures);
    if (blocked) {
      return res.status(409).json({ error: blocked });
    }

    const parsedText = editedText.safeParse(req.body);
    if (!parsedText.success) {
      return res.status(400).json({ error: parsedText.error.issues[0].message });
    }
    const text: ReminderText = { ...parsedText.data, paragraphs: parsedText.data.paragraphs.filter(Boolean) };
    const subject = reminderSubject(text.subject, figures.invoiceNumber);
    const html = renderReminderHtml(text, figures);

    let emailRequest: ReturnType<typeof parseEmailRequest>;
    try {
      emailRequest = parseEmailRequest({
        emailData: {
          recipients: req.body?.recipients,
          cc: req.body?.cc,
          subject,
          htmlBody: html,
          invoiceNumber: figures.invoiceNumber,
        },
        smtpConfig: isRecord(req.body?.smtpConfig) ? req.body.smtpConfig : undefined,
      });
    } catch (error) {
      if (error instanceof InputError) return res.status(400).json({ error: error.message });
      throw error;
    }

    const result = await dispatchEmail(pool, user, emailRequest, createTransport);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    const updated = await pool.query<{ sent_at: Date }>(
      `UPDATE payment_reminders SET status = 'sent', subject = $3, body_html = $4, message_id = $5, sent_at = now()
       WHERE id = $1 AND organization_id = $2 AND status = 'draft'
       RETURNING sent_at`,
      [found.id, user.organizationId, subject, html, result.messageId],
    );
    return res.json({
      id: found.id,
      status: 'sent',
      mode: result.mode,
      sentAt: updated.rows[0] ? new Date(updated.rows[0].sent_at).toISOString() : new Date().toISOString(),
    });
  }));

  app.post('/api/reminders/:id/discard', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Reminder not found.' });
    }
    const result = await pool.query<{ status: string }>(
      `UPDATE payment_reminders SET status = 'discarded'
       WHERE id = $1 AND organization_id = $2 AND status = 'draft'
       RETURNING status`,
      [req.params.id, user.organizationId],
    );
    if (result.rowCount === 0) {
      const exists = await pool.query('SELECT 1 FROM payment_reminders WHERE id = $1 AND organization_id = $2', [
        req.params.id,
        user.organizationId,
      ]);
      return exists.rowCount
        ? res.status(409).json({ error: 'Only a draft reminder can be discarded.' })
        : res.status(404).json({ error: 'Reminder not found.' });
    }
    return res.json({ id: req.params.id, status: 'discarded' });
  }));
}
