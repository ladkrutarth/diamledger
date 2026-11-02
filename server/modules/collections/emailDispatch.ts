import type { Express } from 'express';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { DbPool } from '../../core/db.js';
import { isValidEmail } from '../auth/auth.js';
import { asyncHandler, currentUser, isRecord, requireUser, type CurrentUser } from '../../core/http.js';

export const MAX_RECIPIENTS = 10;
const MAX_ATTACHMENTS = 2;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_HTML_LENGTH = 200_000;
const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  allowInvalidCertificates: boolean;
};

export type MailTransport = {
  verify: () => Promise<unknown>;
  sendMail: (message: SendMailOptions) => Promise<{ messageId?: string; accepted?: unknown[] }>;
};

export type CreateMailTransport = (settings: SmtpSettings) => MailTransport;

export const createSmtpTransport: CreateMailTransport = (settings) =>
  nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    requireTLS: !settings.secure && settings.port !== 25,
    tls: { rejectUnauthorized: !settings.allowInvalidCertificates },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

export class InputError extends Error {}

function text(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InputError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InputError(`${label} is too long.`);
  return trimmed;
}

export function parseSmtpSettings(value: unknown): SmtpSettings | null {
  if (!isRecord(value)) return null;
  const host = text(value.host, 255, 'SMTP host').toLowerCase();
  const user = text(value.user, 320, 'SMTP username');
  const pass = typeof value.pass === 'string' ? value.pass.trim() : '';
  if (!host || !user || !pass) return null;

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new InputError('Enter the SMTP host name, for example smtp.gmail.com.');
  }
  const port = Number(value.port) || 587;
  if (!ALLOWED_PORTS.has(port)) {
    throw new InputError('SMTP port must be 25, 465, 587, or 2525.');
  }
  return {
    host,
    port,
    secure: Boolean(value.secure),
    user,
    pass,
    allowInvalidCertificates: value.allowInvalidCertificates === true,
  };
}

function emailList(value: unknown, label: string): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const list = raw.map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : '')).filter(Boolean);
  for (const address of list) {
    if (!isValidEmail(address) || address.length > 320) throw new InputError(`${label} has an invalid address: ${address}`);
  }
  return [...new Set(list)];
}

type Attachment = { filename: string; content: Buffer; contentType: 'application/pdf' };

function parseAttachments(value: unknown): Attachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError('Attachments are invalid.');
  if (value.length > MAX_ATTACHMENTS) throw new InputError(`At most ${MAX_ATTACHMENTS} attachments can be sent.`);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.content !== 'string') throw new InputError('Attachments are invalid.');
    if ((entry.contentType ?? 'application/pdf') !== 'application/pdf') {
      throw new InputError('Only PDF attachments can be sent.');
    }
    const filename = text(entry.filename, 200, 'Attachment name').replace(/[\\/\r\n"]/g, '_') || 'document.pdf';
    const content = Buffer.from(entry.content.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (content.length > MAX_ATTACHMENT_BYTES) throw new InputError('Each attachment must be under 10 MB.');
    return { filename, content, contentType: 'application/pdf' as const };
  });
}

export function parseEmailRequest(body: unknown) {
  if (!isRecord(body) || !isRecord(body.emailData)) throw new InputError('Email details are missing.');
  const { emailData } = body;
  const recipients = emailList(emailData.recipients, 'Recipients');
  const cc = emailList(emailData.cc, 'CC').filter((address) => !recipients.includes(address));
  if (recipients.length === 0) throw new InputError('At least one recipient email is required.');
  if (recipients.length + cc.length > MAX_RECIPIENTS) {
    throw new InputError(`An email can go to at most ${MAX_RECIPIENTS} addresses, including CC.`);
  }

  const subject = text(emailData.subject, 300, 'Subject');
  if (!subject) throw new InputError('Subject is required.');
  if (/[\r\n]/.test(subject)) throw new InputError('Subject must be a single line.');
  const htmlBody = typeof emailData.htmlBody === 'string' ? emailData.htmlBody : '';
  if (htmlBody.length > MAX_HTML_LENGTH) throw new InputError('Email body is too long.');

  const smtp = isRecord(body.smtpConfig) ? body.smtpConfig : {};
  return {
    recipients,
    cc,
    subject,
    htmlBody,
    invoiceNumber: text(emailData.invoiceNumber, 200, 'Invoice number'),
    fromName: text(smtp.fromName, 120, 'Sender name').replace(/["<>\r\n]/g, ''),
    fromEmail: text(smtp.fromEmail, 320, 'Sender email'),
    attachments: parseAttachments(body.attachments),
    settings: parseSmtpSettings(body.smtpConfig),
  };
}

export type EmailRequest = ReturnType<typeof parseEmailRequest>;

export type DispatchResult =
  | { ok: true; mode: 'preview_simulated' | 'live_smtp'; messageId: string | null; accepted: unknown[] }
  | { ok: false; status: 400 | 502; error: string };

export async function dispatchEmail(
  pool: DbPool,
  user: CurrentUser,
  request: EmailRequest,
  createTransport: CreateMailTransport,
): Promise<DispatchResult> {
  const { settings } = request;
  let mode: 'preview_simulated' | 'live_smtp' = 'preview_simulated';
  let messageId: string | null = null;
  let accepted: unknown[] = [];

  if (settings) {
    if (request.fromEmail && !isValidEmail(request.fromEmail)) {
      return { ok: false, status: 400, error: 'Sender email is invalid.' };
    }
    try {
      const info = await createTransport(settings).sendMail({
        from: { name: request.fromName || user.organizationName, address: request.fromEmail || settings.user },
        to: request.recipients,
        cc: request.cc.length ? request.cc : undefined,
        subject: request.subject,
        html: request.htmlBody,
        attachments: request.attachments,
      });
      mode = 'live_smtp';
      messageId = info.messageId ?? null;
      accepted = info.accepted ?? [];
    } catch (error: any) {
      console.error('SMTP dispatch failed:', error?.message);
      return { ok: false, status: 502, error: `The mail server rejected the email: ${error?.message || 'unknown error'}` };
    }
  }

  await pool.query(
    `INSERT INTO email_dispatches
       (organization_id, user_id, mode, smtp_host, recipients, cc, subject, invoice_number, attachment_count, message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [user.organizationId, user.id, mode, settings?.host ?? null, request.recipients, request.cc, request.subject,
      request.invoiceNumber, request.attachments.length, messageId],
  );
  console.info(JSON.stringify({
    event: 'email_dispatch',
    mode,
    userId: user.id,
    organizationId: user.organizationId,
    recipients: request.recipients.length + request.cc.length,
    invoiceNumber: request.invoiceNumber,
  }));
  return { ok: true, mode, messageId, accepted };
}

export function registerEmailRoutes(app: Express, pool: DbPool, createTransport: CreateMailTransport): void {
  app.post('/api/send-email', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    let request: EmailRequest;
    try {
      request = parseEmailRequest(req.body);
    } catch (error) {
      if (error instanceof InputError) return res.status(400).json({ error: error.message });
      throw error;
    }

    const result = await dispatchEmail(pool, user, request, createTransport);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const { mode, messageId, accepted } = result;

    if (mode === 'preview_simulated') {
      return res.json({
        success: true,
        mode,
        log: {
          status: 'simulated_success',
          message: 'Email was not sent. Enter SMTP credentials to send real email.',
          timestamp: new Date().toISOString(),
          recipients: request.recipients,
          cc: request.cc,
          subject: request.subject,
          attachmentsCount: request.attachments.length,
          invoiceNumber: request.invoiceNumber,
        },
      });
    }
    return res.json({ success: true, mode, messageId, accepted });
  }));

  app.post('/api/verify-smtp', requireUser, asyncHandler(async (req, res) => {
    let settings: SmtpSettings | null;
    try {
      settings = parseSmtpSettings(req.body);
    } catch (error) {
      if (error instanceof InputError) return res.status(400).json({ success: false, error: error.message });
      throw error;
    }
    if (!settings) {
      return res.status(400).json({ success: false, error: 'Host, Username, and Password are required.' });
    }
    try {
      await createTransport(settings).verify();
      return res.json({ success: true, message: 'SMTP connection verified successfully.' });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: error?.message || 'SMTP Connection failed. Verify host, port, and security credentials.',
      });
    }
  }));
}
