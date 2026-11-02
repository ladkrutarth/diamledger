import type { Express } from 'express';
import { Type } from '@google/genai';
import { z } from 'zod';
import type { DbPool } from '../../core/db.js';
import { callModel, usageFrom, type TokenUsage } from '../../ai/call.js';
import { GEMINI_MODEL, activeModelName, aiProvider, gemini } from '../../ai/client.js';
import { hfJson } from '../../ai/huggingface.js';
import { isGrounded } from '../../assistant/agent.js';
import { formReader, isoToday } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid, requireRoles } from '../../core/http.js';
import { money } from './taxShared.js';

export const NOTICE_PROMPT_VERSION = 'notice-reply-v1';
export const AUTHORITIES = ['gst', 'income_tax', 'customs', 'dgft', 'rbi', 'other'] as const;
type Authority = (typeof AUTHORITIES)[number];
const STATUSES = ['open', 'replied', 'closed'] as const;

export const AUTHORITY_LABELS: Record<Authority, string> = {
  gst: 'GST department',
  income_tax: 'Income Tax department',
  customs: 'Customs',
  dgft: 'DGFT',
  rbi: 'RBI / AD bank',
  other: 'Other authority',
};

export type NoticeFacts = {
  companyName: string;
  gstin: string;
  authority: string;
  formType: string;
  referenceNo: string;
  period: string;
  issuedOn: string | null;
  replyDue: string | null;
  amountInr: number | null;
  summary: string;
  invoices: Array<{
    invoiceNumber: string;
    invoiceDate: string;
    buyerName: string;
    destinationCountry: string;
    totalUsd: number;
    exportScheme: string;
    shippingBillNo: string;
    shippingBillDate: string | null;
    portCode: string;
    brcNumber: string;
    brcDate: string | null;
    receivedUsd: number;
  }>;
};

export type DraftNoticeReply = (facts: NoticeFacts, signal?: AbortSignal) => Promise<{ paragraphs: string[]; usage?: TokenUsage }>;

const SYSTEM_PROMPT = `You draft a formal reply from an Indian diamond exporter to a tax or regulatory notice.
Use only the facts given: the notice details, and the export invoices with their shipping bills and bank realization (BRC).
Never invent an amount, date, number, section, or document that is not in the facts. If something needed is missing, say the
company will furnish it, and name what it is. Write in plain, respectful English, in short paragraphs, starting with the subject
of the notice and ending before the sign-off (the system adds the signature). Do not give legal opinions; state facts and enclosures.`;

const replySchema = z.object({ paragraphs: z.array(z.string().trim().min(1).max(2000)).min(1).max(12) });

export const geminiNoticeReply: DraftNoticeReply = async (facts, signal) => {
  const response = await gemini().models.generateContent({
    model: GEMINI_MODEL,
    contents: { parts: [{ text: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}` }] },
    config: {
      abortSignal: signal,
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: { paragraphs: { type: Type.ARRAY, items: { type: Type.STRING } } },
        required: ['paragraphs'],
      },
    },
  });
  return { ...JSON.parse(response.text || '{}'), usage: usageFrom(response.usageMetadata) };
};

export const defaultNoticeReply: DraftNoticeReply = async (facts, signal) => {
  if (aiProvider() !== 'huggingface') return geminiNoticeReply(facts, signal);
  const { value, usage } = await hfJson(SYSTEM_PROMPT, `Facts (JSON):\n${JSON.stringify(facts, null, 2)}`, '{"paragraphs": string[]}', signal);
  return { ...(value as { paragraphs: string[] }), usage };
};

const usd = (value: number) => `USD ${value.toFixed(2)}`;

/** A reply written from the facts alone, used when the model is unavailable or its draft cannot be trusted. */
export function templateNoticeReply(facts: NoticeFacts): string[] {
  const subject = [facts.formType, facts.referenceNo && `reference ${facts.referenceNo}`, facts.issuedOn && `dated ${facts.issuedOn}`]
    .filter(Boolean)
    .join(', ');
  const paragraphs = [
    `Subject: Reply to ${subject || 'your notice'}${facts.period ? ` for the period ${facts.period}` : ''}.`,
    `With reference to the above, ${facts.companyName || 'we'}${facts.gstin ? ` (GSTIN ${facts.gstin})` : ''} submit the following for your kind consideration.`,
  ];
  if (facts.invoices.length) {
    paragraphs.push('The exports in question are listed below with their shipping bills and bank realization:');
    for (const invoice of facts.invoices) {
      const parts = [
        `Invoice ${invoice.invoiceNumber} dated ${invoice.invoiceDate} to ${invoice.buyerName}${invoice.destinationCountry ? `, ${invoice.destinationCountry}` : ''}, value ${usd(invoice.totalUsd)}`,
        invoice.exportScheme === 'igst' ? 'exported on payment of IGST' : 'exported under LUT without payment of IGST',
        invoice.shippingBillNo ? `shipping bill ${invoice.shippingBillNo}${invoice.shippingBillDate ? ` dated ${invoice.shippingBillDate}` : ''}${invoice.portCode ? ` at port ${invoice.portCode}` : ''}` : 'shipping bill details to be furnished',
        invoice.brcNumber ? `realized under BRC ${invoice.brcNumber}${invoice.brcDate ? ` dated ${invoice.brcDate}` : ''}` : invoice.receivedUsd > 0 ? `${usd(invoice.receivedUsd)} received so far` : 'realization pending',
      ];
      paragraphs.push(`• ${parts.join('; ')}.`);
    }
  }
  paragraphs.push('Copies of the invoices, shipping bills, and bank realization certificates are enclosed. We request you to take the above on record and drop the proceedings. We will furnish any further information you may require.');
  return paragraphs;
}

type NoticeRow = {
  id: string; authority: Authority; form_type: string; reference_no: string; period: string; issued_on: string | null;
  reply_due: string | null; amount_inr: string | null; status: (typeof STATUSES)[number]; summary: string; reply: string;
  reply_source: string; invoice_ids: string[]; created_at: Date; updated_at: Date; invoice_numbers: string[] | null;
};

function toNotice(row: NoticeRow, today: string) {
  const daysLeft = row.reply_due ? Math.round((Date.parse(`${row.reply_due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return {
    id: row.id,
    authority: row.authority,
    authorityLabel: AUTHORITY_LABELS[row.authority],
    formType: row.form_type,
    referenceNo: row.reference_no,
    period: row.period,
    issuedOn: row.issued_on,
    replyDue: row.reply_due,
    daysLeft,
    urgency: row.status !== 'open' || daysLeft === null ? 'none' : daysLeft < 0 ? 'overdue' : daysLeft <= 7 ? 'due_soon' : 'upcoming',
    amountInr: row.amount_inr === null ? null : money(row.amount_inr),
    status: row.status,
    summary: row.summary,
    reply: row.reply,
    replySource: row.reply_source,
    invoiceIds: row.invoice_ids,
    invoiceNumbers: row.invoice_numbers ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const NOTICE_SELECT = `SELECT n.id, n.authority, n.form_type, n.reference_no, n.period, to_char(n.issued_on, 'YYYY-MM-DD') AS issued_on,
    to_char(n.reply_due, 'YYYY-MM-DD') AS reply_due, n.amount_inr, n.status, n.summary, n.reply, n.reply_source, n.invoice_ids,
    n.created_at, n.updated_at,
    (SELECT ARRAY_AGG(i.invoice_number ORDER BY i.invoice_number) FROM invoices i WHERE i.id = ANY(n.invoice_ids)) AS invoice_numbers
  FROM tax_notices n`;

export async function openNoticeCounts(pool: DbPool, organizationId: string) {
  const result = await pool.query<{ open: string; due_soon: string; overdue: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
            COUNT(*) FILTER (WHERE status = 'open' AND reply_due BETWEEN current_date AND current_date + 7) AS due_soon,
            COUNT(*) FILTER (WHERE status = 'open' AND reply_due < current_date) AS overdue
     FROM tax_notices WHERE organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  return { open: Number(row.open), dueSoon: Number(row.due_soon), overdue: Number(row.overdue) };
}

async function readNotice(pool: DbPool, organizationId: string, body: unknown) {
  const form = formReader(body);
  const invoiceNumbers = Array.isArray(form.raw.invoiceNumbers)
    ? (form.raw.invoiceNumbers as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim() !== '').slice(0, 50)
    : typeof form.raw.invoiceNumbers === 'string'
      ? (form.raw.invoiceNumbers as string).split(/[\s,;]+/).filter(Boolean).slice(0, 50)
      : [];
  let invoiceIds: string[] = [];
  if (invoiceNumbers.length) {
    const found = await pool.query<{ id: string; invoice_number: string }>(
      `SELECT id, invoice_number FROM invoices WHERE organization_id = $1 AND UPPER(invoice_number) = ANY($2::text[])`,
      [organizationId, invoiceNumbers.map((value) => value.trim().toUpperCase())],
    );
    const known = new Set(found.rows.map((row) => row.invoice_number.toUpperCase()));
    const missing = invoiceNumbers.filter((value) => !known.has(value.trim().toUpperCase()));
    if (missing.length) throw Object.assign(new Error(`No invoice numbered ${missing.join(', ')}.`), { status: 400 });
    invoiceIds = found.rows.map((row) => row.id);
  }
  return {
    authority: form.choice<Authority>('authority', AUTHORITIES, 'gst'),
    formType: form.required('formType', 'Enter the notice form or type, for example ASMT-10, DRC-01, or section 143(2).', 100),
    referenceNo: form.text('referenceNo', 100),
    period: form.text('period', 50),
    issuedOn: form.date('issuedOn', 'Enter the notice date as YYYY-MM-DD.', true),
    replyDue: form.date('replyDue', 'Enter the reply due date as YYYY-MM-DD.', true),
    amountInr: form.number('amountInr', 'The amount must be zero or more rupees.', { min: 0, optional: true }),
    status: form.choice('status', STATUSES, 'open'),
    summary: form.text('summary', 4000),
    reply: form.text('reply', 20000),
    invoiceIds,
  };
}

async function noticeFacts(pool: DbPool, organizationId: string, noticeId: string): Promise<NoticeFacts | null> {
  const notice = await pool.query<NoticeRow & { company_name: string; gstin: string }>(
    `${NOTICE_SELECT.replace('FROM tax_notices n', ", o.name AS company_name, COALESCE(o.profile->'exporter'->>'gstin', o.profile->>'gstin', '') AS gstin FROM tax_notices n JOIN organizations o ON o.id = n.organization_id")}
     WHERE n.id = $1 AND n.organization_id = $2`,
    [noticeId, organizationId],
  );
  const row = notice.rows[0];
  if (!row) return null;
  const invoices = await pool.query<{
    invoice_number: string; invoice_date: string; buyer_name: string; destination_country: string; total_usd: string; export_scheme: string;
    shipping_bill_no: string; shipping_bill_date: string | null; port_code: string; brc_number: string; brc_date: string | null; received_usd: string;
  }>(
    `SELECT i.invoice_number, to_char(COALESCE(i.invoice_date, i.created_at::date), 'YYYY-MM-DD') AS invoice_date, i.buyer_name,
            i.destination_country, i.total_usd, COALESCE(t.export_scheme, 'lut') AS export_scheme, COALESCE(t.shipping_bill_no, '') AS shipping_bill_no,
            to_char(t.shipping_bill_date, 'YYYY-MM-DD') AS shipping_bill_date, COALESCE(t.port_code, '') AS port_code,
            COALESCE(b.brc_number, '') AS brc_number, to_char(b.realised_on, 'YYYY-MM-DD') AS brc_date,
            COALESCE((SELECT SUM(amount_usd) FROM payments p WHERE p.invoice_id = i.id), 0) AS received_usd
     FROM invoices i LEFT JOIN invoice_tax t ON t.invoice_id = i.id LEFT JOIN invoice_brcs b ON b.invoice_id = i.id
     WHERE i.organization_id = $1 AND i.id = ANY($2::uuid[])
     ORDER BY i.invoice_number`,
    [organizationId, row.invoice_ids],
  );
  return {
    companyName: row.company_name,
    gstin: row.gstin,
    authority: AUTHORITY_LABELS[row.authority],
    formType: row.form_type,
    referenceNo: row.reference_no,
    period: row.period,
    issuedOn: row.issued_on,
    replyDue: row.reply_due,
    amountInr: row.amount_inr === null ? null : money(row.amount_inr),
    summary: row.summary,
    invoices: invoices.rows.map((invoice) => ({
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      buyerName: invoice.buyer_name,
      destinationCountry: invoice.destination_country,
      totalUsd: money(invoice.total_usd),
      exportScheme: invoice.export_scheme,
      shippingBillNo: invoice.shipping_bill_no,
      shippingBillDate: invoice.shipping_bill_date,
      portCode: invoice.port_code,
      brcNumber: invoice.brc_number,
      brcDate: invoice.brc_date,
      receivedUsd: money(invoice.received_usd),
    })),
  };
}

const noticeReader = requireRoles('admin', 'tax', 'ca');
const noticeWriter = requireRoles('admin', 'tax', 'ca');
const noticeDeleter = requireRoles('admin', 'tax');

export function registerNoticeRoutes(app: Express, pool: DbPool, drafter: DraftNoticeReply = defaultNoticeReply): void {
  app.get('/api/notices', noticeReader, asyncHandler(async (req, res) => {
    const result = await pool.query<NoticeRow>(
      `${NOTICE_SELECT} WHERE n.organization_id = $1 ORDER BY (n.status <> 'open'), n.reply_due NULLS LAST, n.created_at DESC LIMIT 500`,
      [currentUser(res).organizationId],
    );
    const today = isoToday();
    return res.json({ notices: result.rows.map((row) => toNotice(row, today)), authorities: AUTHORITY_LABELS });
  }));

  app.post('/api/notices', noticeWriter, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const input = await readNotice(pool, user.organizationId, req.body);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO tax_notices (organization_id, authority, form_type, reference_no, period, issued_on, reply_due, amount_inr, status,
         summary, reply, invoice_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [user.organizationId, input.authority, input.formType, input.referenceNo, input.period, input.issuedOn, input.replyDue,
        input.amountInr, input.status, input.summary, input.reply, input.invoiceIds, user.id],
    );
    return res.status(201).json({ id: inserted.rows[0].id });
  }));

  app.put('/api/notices/:id', noticeWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Notice not found.' });
    const user = currentUser(res);
    const input = await readNotice(pool, user.organizationId, req.body);
    const updated = await pool.query(
      `UPDATE tax_notices SET authority = $3, form_type = $4, reference_no = $5, period = $6, issued_on = $7, reply_due = $8,
         amount_inr = $9, status = $10, summary = $11, reply = $12, invoice_ids = $13,
         reply_source = CASE WHEN reply = $12 THEN reply_source ELSE 'edited' END, updated_at = now()
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId, input.authority, input.formType, input.referenceNo, input.period, input.issuedOn,
        input.replyDue, input.amountInr, input.status, input.summary, input.reply, input.invoiceIds],
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'Notice not found.' });
    return res.json({ id: req.params.id });
  }));

  app.delete('/api/notices/:id', noticeDeleter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Notice not found.' });
    const deleted = await pool.query('DELETE FROM tax_notices WHERE id = $1 AND organization_id = $2', [req.params.id, currentUser(res).organizationId]);
    if (!deleted.rowCount) return res.status(404).json({ error: 'Notice not found.' });
    return res.json({ deleted: true });
  }));

  /** Drafts a reply from the notice and its linked invoices. The draft is saved but nothing is sent. */
  app.post('/api/notices/:id/draft-reply', noticeWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Notice not found.' });
    const user = currentUser(res);
    const facts = await noticeFacts(pool, user.organizationId, req.params.id);
    if (!facts) return res.status(404).json({ error: 'Notice not found.' });
    let paragraphs: string[] | null = null;
    let source: 'model' | 'template' = 'template';
    let note = '';
    try {
      const drafted = await callModel(
        pool,
        { feature: 'notice_reply', promptVersion: NOTICE_PROMPT_VERSION, model: activeModelName(), organizationId: user.organizationId, userId: user.id },
        async (signal) => {
          const { usage, ...value } = await drafter(facts, signal);
          return { value, usage };
        },
      );
      const parsed = replySchema.safeParse(drafted);
      if (!parsed.success) note = 'The AI draft was not in the expected shape, so a draft written from your records is shown.';
      else if (!isGrounded(parsed.data.paragraphs.join('\n'), [facts])) note = 'The AI draft mentioned an amount that is not in your records, so a draft written from your records is shown.';
      else {
        paragraphs = parsed.data.paragraphs;
        source = 'model';
      }
    } catch (error) {
      note = `AI drafting was not available (${(error as Error).message}). A draft written from your records is shown.`;
    }
    const reply = (paragraphs ?? templateNoticeReply(facts)).join('\n\n');
    await pool.query(`UPDATE tax_notices SET reply = $3, reply_source = $4, updated_at = now() WHERE id = $1 AND organization_id = $2`, [
      req.params.id,
      user.organizationId,
      reply,
      source,
    ]);
    return res.json({ reply, source, note });
  }));
}
