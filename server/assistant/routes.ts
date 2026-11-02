import type { Express } from 'express';
import type { Content } from '@google/genai';
import type { DbPool } from '../core/db.js';
import { asyncHandler, currentUser, isUuid, requireRoles, requireUser, type CurrentUser } from '../core/http.js';
import { AiUnavailableError } from '../ai/client.js';
import { currentSuggestion, matchBankLine } from '../modules/banking/bank.js';
import { parseMonth } from '../modules/tax/closedMonths.js';
import { recordPayment } from '../modules/invoices/payments.js';
import { createReminderDraft, type DraftReminderText } from '../modules/collections/reminders.js';
import { closeMonth } from '../modules/tax/tax.js';
import { runTurn, SessionFullError, type AssistantModel } from './agent.js';
import { runReview } from './review.js';
import { CONFIRM_ROLES, monthCloseCheck, TAX_READERS, type ProposedAction } from './tools.js';

const MAX_MESSAGE_LENGTH = 2000;

type ActionRow = {
  id: string;
  kind: ProposedAction['kind'];
  status: ProposedAction['status'];
  payload: Record<string, unknown>;
  result: unknown;
  created_at: Date;
};

function toAction(row: ActionRow): ProposedAction {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: row.payload,
    result: row.result ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function ownSession(pool: DbPool, id: string, user: CurrentUser) {
  if (!isUuid(id)) return undefined;
  const result = await pool.query<{ id: string; created_at: Date }>(
    'SELECT id, created_at FROM assistant_sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3',
    [id, user.organizationId, user.id],
  );
  return result.rows[0];
}

async function ownAction(pool: DbPool, id: string, user: CurrentUser) {
  if (!isUuid(id)) return undefined;
  const result = await pool.query<ActionRow>(
    `SELECT a.id, a.kind, a.status, a.payload, a.result, a.created_at
     FROM assistant_actions a JOIN assistant_sessions s ON s.id = a.session_id
     WHERE a.id = $1 AND a.organization_id = $2 AND s.organization_id = $2 AND s.user_id = $3`,
    [id, user.organizationId, user.id],
  );
  return result.rows[0];
}

async function paidSoFar(pool: DbPool, invoiceId: string, organizationId: string) {
  const result = await pool.query<{ status: string; paid: string }>(
    `SELECT i.status, COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid
     FROM invoices i WHERE i.id = $1 AND i.organization_id = $2`,
    [invoiceId, organizationId],
  );
  const row = result.rows[0];
  return row ? { status: row.status, paidUsd: Math.round(Number(row.paid) * 100) / 100 } : undefined;
}

function visibleText(content: Content): string {
  return (content.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
}

type Execution = { ok: true; result: unknown } | { ok: false; error: string };

async function execute(
  pool: DbPool,
  user: CurrentUser,
  action: ActionRow,
  drafter: DraftReminderText,
): Promise<Execution> {
  if (action.kind === 'close_month') {
    const month = parseMonth(action.payload.month);
    if (!month) return { ok: false, error: 'This proposal has no valid month.' };
    const check = await monthCloseCheck(pool, user.organizationId, month);
    if (!check.ok) return { ok: false, error: check.error };
    await closeMonth(pool, user.organizationId, month, user.id);
    return { ok: true, result: { month, closed: true } };
  }

  const invoiceId = String(action.payload.invoiceId ?? '');
  const current = await paidSoFar(pool, invoiceId, user.organizationId);
  if (!current) return { ok: false, error: 'This invoice no longer exists.' };
  if (current.status !== 'issued' || current.paidUsd !== Number(action.payload.paidUsdAtProposal)) {
    return {
      ok: false,
      error: 'This invoice has changed since the assistant proposed this. Ask the assistant again for an up-to-date proposal.',
    };
  }

  if (action.kind === 'record_payment') {
    const outcome = await recordPayment(
      pool,
      user,
      invoiceId,
      { amountUsd: action.payload.amountUsd, paidOn: action.payload.paidOn, reference: action.payload.reference },
      { withinBalance: true },
    );
    return outcome.ok
      ? { ok: true, result: { invoiceStatus: outcome.state.status, paidUsd: outcome.state.paidUsd, dueUsd: outcome.state.dueUsd } }
      : { ok: false, error: outcome.error };
  }

  if (action.kind === 'match_bank_line') {
    const lineId = String(action.payload.lineId ?? '');
    if (!isUuid(lineId) || !(await currentSuggestion(pool, user.organizationId, lineId, invoiceId))) {
      return {
        ok: false,
        error: 'This bank line or invoice has changed since the assistant proposed this. Ask the assistant again for an up-to-date proposal.',
      };
    }
    const outcome = await matchBankLine(pool, user, lineId, invoiceId);
    return outcome.ok
      ? { ok: true, result: { invoiceStatus: outcome.status, dueUsd: outcome.dueUsd } }
      : { ok: false, error: outcome.error };
  }

  const outcome = await createReminderDraft(pool, user, drafter, invoiceId, { confirmRepeat: true });
  return outcome.ok
    ? { ok: true, result: { reminderId: outcome.draft.id, subject: outcome.draft.fullSubject } }
    : { ok: false, error: outcome.error };
}

export function registerAssistantRoutes(
  app: Express,
  pool: DbPool,
  model: AssistantModel,
  drafter: DraftReminderText,
): void {
  app.post('/api/assistant/sessions', requireUser, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    const result = await pool.query<{ id: string; created_at: Date }>(
      'INSERT INTO assistant_sessions (organization_id, user_id) VALUES ($1, $2) RETURNING id, created_at',
      [user.organizationId, user.id],
    );
    return res.status(201).json({
      id: result.rows[0].id,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
      messages: [],
      actions: [],
    });
  }));

  app.get('/api/assistant/sessions/:id', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const session = await ownSession(pool, req.params.id, user);
    if (!session) return res.status(404).json({ error: 'Conversation not found.' });
    const [messages, actions] = await Promise.all([
      pool.query<{ id: string; role: string; content: Content; created_at: Date }>(
        `SELECT id, role, content, created_at FROM assistant_messages
         WHERE session_id = $1 AND role IN ('user', 'model') ORDER BY created_at, id`,
        [session.id],
      ),
      pool.query<ActionRow>(
        `SELECT id, kind, status, payload, result, created_at FROM assistant_actions
         WHERE session_id = $1 AND organization_id = $2 ORDER BY created_at`,
        [session.id, user.organizationId],
      ),
    ]);
    return res.json({
      id: session.id,
      createdAt: new Date(session.created_at).toISOString(),
      messages: messages.rows
        .map((row) => ({
          id: row.id,
          role: row.role as 'user' | 'model',
          text: visibleText(row.content),
          createdAt: new Date(row.created_at).toISOString(),
        }))
        .filter((message) => message.text),
      actions: actions.rows.map(toAction),
    });
  }));

  app.post('/api/assistant/sessions/:id/messages', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const session = await ownSession(pool, req.params.id, user);
    if (!session) return res.status(404).json({ error: 'Conversation not found.' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Type a question for the assistant.' });
    if (text.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Keep questions under ${MAX_MESSAGE_LENGTH} characters.` });
    }
    try {
      return res.json(await runTurn(pool, user, session.id, model, text));
    } catch (error) {
      if (error instanceof AiUnavailableError) return res.status(503).json({ error: error.message, reason: error.reason });
      if (error instanceof SessionFullError) return res.status(409).json({ error: error.message, sessionFull: true });
      if (typeof (error as { status?: unknown })?.status === 'number') {
        return res.status(502).json({ error: 'The AI service returned an error. Try again in a moment.' });
      }
      throw error;
    }
  }));

  app.post('/api/assistant/reviews', requireRoles(...TAX_READERS), asyncHandler(async (req, res) => {
    const month = parseMonth(req.body?.month);
    if (!month) return res.status(400).json({ error: 'Choose a month like 2026-10.' });
    return res.status(201).json(await runReview(pool, currentUser(res), model, month));
  }));

  app.post('/api/assistant/actions/:id/confirm', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const action = await ownAction(pool, req.params.id, user);
    if (!action) return res.status(404).json({ error: 'Proposal not found.' });
    if (!CONFIRM_ROLES[action.kind].includes(user.role)) {
      return res.status(403).json({ error: 'Your role cannot confirm this kind of proposal.' });
    }
    const claimed = await pool.query(
      `UPDATE assistant_actions SET status = 'confirmed', decided_by = $2, decided_at = now()
       WHERE id = $1 AND status = 'proposed'`,
      [action.id, user.id],
    );
    if (claimed.rowCount === 0) {
      return res.status(409).json({ error: `This proposal was already ${action.status}.` });
    }

    let outcome: Execution;
    try {
      outcome = await execute(pool, user, action, drafter);
    } catch (error) {
      await pool.query(`UPDATE assistant_actions SET status = 'failed', result = $2::jsonb WHERE id = $1`, [
        action.id,
        JSON.stringify({ error: 'Something went wrong.' }),
      ]);
      throw error;
    }
    const saved = await pool.query<ActionRow>(
      `UPDATE assistant_actions SET status = $2, result = $3::jsonb WHERE id = $1
       RETURNING id, kind, status, payload, result, created_at`,
      [action.id, outcome.ok ? 'confirmed' : 'failed', JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error })],
    );
    console.info(JSON.stringify({
      event: 'assistant_action_decided',
      kind: action.kind,
      status: saved.rows[0].status,
      organizationId: user.organizationId,
    }));
    if (!outcome.ok) return res.status(409).json({ error: outcome.error, action: toAction(saved.rows[0]) });
    return res.json({ action: toAction(saved.rows[0]) });
  }));

  app.post('/api/assistant/actions/:id/reject', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const action = await ownAction(pool, req.params.id, user);
    if (!action) return res.status(404).json({ error: 'Proposal not found.' });
    const saved = await pool.query<ActionRow>(
      `UPDATE assistant_actions SET status = 'rejected', decided_by = $2, decided_at = now()
       WHERE id = $1 AND status = 'proposed'
       RETURNING id, kind, status, payload, result, created_at`,
      [action.id, user.id],
    );
    if (saved.rowCount === 0) return res.status(409).json({ error: `This proposal was already ${action.status}.` });
    return res.json({ action: toAction(saved.rows[0]) });
  }));
}
