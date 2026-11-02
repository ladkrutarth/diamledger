import type { Express, NextFunction, Request, Response } from 'express';
import type { DbPool } from '../../core/db.js';
import { openRequestCounts } from './clientRequests.js';
import { currentFinancialYear, financialYearDates, formReader, isoToday } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid } from '../../core/http.js';
import { openNoticeCounts } from '../tax/notices.js';
import { money } from '../tax/taxShared.js';
import { complianceItems } from './workspace.js';

const BILLING = ['monthly', 'quarterly', 'yearly', 'per_task'] as const;

/** Clients are the companies that have given this user accountant access. */
async function clientsOf(pool: DbPool, userId: string) {
  const result = await pool.query<{ id: string; name: string; role: string }>(
    `SELECT o.id, o.name, a.role FROM organization_access a JOIN organizations o ON o.id = a.organization_id
     WHERE a.user_id = $1 ORDER BY o.name`,
    [userId],
  );
  return result.rows;
}

/** The practice tools are for accountants: anyone with access to at least one client company. */
function practiceUser(pool: DbPool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user;
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    clientsOf(pool, user.id)
      .then((clients) => {
        if (!clients.length) {
          res.status(403).json({ error: 'The practice tools are for accountants with access to client companies.' });
          return;
        }
        res.locals.practiceClients = clients;
        next();
      })
      .catch(next);
  };
}

function clientIdFrom(res: Response, value: unknown): string | null {
  const clients = res.locals.practiceClients as Array<{ id: string }>;
  return typeof value === 'string' && clients.some((client) => client.id === value) ? value : null;
}

export type HealthGrade = 'good' | 'watch' | 'at_risk';

/** 100 is a client with nothing pending; overdue filings, notices, and requests pull it down. */
export function healthScore(input: { overdue: number; dueSoon: number; actions: number; noticesOverdue: number; noticesDueSoon: number; requestsOverdue: number }) {
  const score = Math.max(
    0,
    100 - input.overdue * 20 - input.noticesOverdue * 25 - input.noticesDueSoon * 10 - input.dueSoon * 5 - input.actions * 5 - input.requestsOverdue * 5,
  );
  const grade: HealthGrade = score >= 80 ? 'good' : score >= 50 ? 'watch' : 'at_risk';
  return { score, grade };
}

export function registerPracticeRoutes(app: Express, pool: DbPool): void {
  const guard = practiceUser(pool);

  app.get('/api/practice/clients', guard, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    const firmId = user.homeOrganizationId;
    const year = financialYearDates(currentFinancialYear())!;
    const month = isoToday().slice(0, 7);
    const clients = res.locals.practiceClients as Array<{ id: string; name: string; role: string }>;
    const today = new Date();
    const rows = [];
    for (const client of clients) {
      const [items, requests, notices, engagement, time, bills] = await Promise.all([
        complianceItems(pool, client, today),
        openRequestCounts(pool, client.id),
        openNoticeCounts(pool, client.id),
        pool.query<{ fee_inr: string; billing: string; notes: string }>(
          'SELECT fee_inr, billing, notes FROM ca_engagements WHERE firm_id = $1 AND client_id = $2',
          [firmId, client.id],
        ),
        pool.query<{ month_minutes: string; year_minutes: string; unbilled_minutes: string }>(
          `SELECT COALESCE(SUM(minutes) FILTER (WHERE to_char(work_date, 'YYYY-MM') = $3), 0) AS month_minutes,
                  COALESCE(SUM(minutes) FILTER (WHERE work_date BETWEEN $4 AND $5), 0) AS year_minutes,
                  COALESCE(SUM(minutes) FILTER (WHERE billable AND work_date BETWEEN $4 AND $5), 0) AS unbilled_minutes
           FROM ca_time_entries WHERE firm_id = $1 AND client_id = $2`,
          [firmId, client.id, month, year.start, year.end],
        ),
        pool.query<{ billed: string; unpaid: string; unpaid_count: string }>(
          `SELECT COALESCE(SUM(amount_inr) FILTER (WHERE bill_date BETWEEN $3 AND $4), 0) AS billed,
                  COALESCE(SUM(amount_inr) FILTER (WHERE paid_on IS NULL), 0) AS unpaid,
                  COUNT(*) FILTER (WHERE paid_on IS NULL) AS unpaid_count
           FROM ca_fee_bills WHERE firm_id = $1 AND client_id = $2`,
          [firmId, client.id, year.start, year.end],
        ),
      ]);
      const overdue = items.filter((item) => item.status === 'overdue').length;
      const dueSoon = items.filter((item) => item.status === 'due_soon').length;
      const actions = items.filter((item) => item.status === 'action').length;
      const health = healthScore({
        overdue,
        dueSoon,
        actions,
        noticesOverdue: notices.overdue,
        noticesDueSoon: notices.dueSoon,
        requestsOverdue: requests.overdue,
      });
      rows.push({
        id: client.id,
        name: client.name,
        role: client.role,
        health: {
          ...health,
          overdue,
          dueSoon,
          actions,
          openRequests: requests.open,
          overdueRequests: requests.overdue,
          openNotices: notices.open,
          noticesDueSoon: notices.dueSoon,
          noticesOverdue: notices.overdue,
          nextItems: items.filter((item) => item.status !== 'done').slice(0, 3).map((item) => ({ title: item.title, dueDate: item.dueDate, status: item.status })),
        },
        engagement: engagement.rows[0]
          ? { feeInr: money(engagement.rows[0].fee_inr), billing: engagement.rows[0].billing, notes: engagement.rows[0].notes }
          : null,
        time: {
          monthMinutes: Number(time.rows[0].month_minutes),
          yearMinutes: Number(time.rows[0].year_minutes),
          billableYearMinutes: Number(time.rows[0].unbilled_minutes),
        },
        fees: {
          billedYearInr: money(bills.rows[0].billed),
          unpaidInr: money(bills.rows[0].unpaid),
          unpaidBills: Number(bills.rows[0].unpaid_count),
        },
      });
    }
    rows.sort((a, b) => a.health.score - b.health.score || a.name.localeCompare(b.name));
    return res.json({
      year: year.label,
      clients: rows,
      totals: {
        clients: rows.length,
        atRisk: rows.filter((row) => row.health.grade === 'at_risk').length,
        unpaidInr: money(rows.reduce((sum, row) => sum + row.fees.unpaidInr, 0)),
        billedYearInr: money(rows.reduce((sum, row) => sum + row.fees.billedYearInr, 0)),
        monthMinutes: rows.reduce((sum, row) => sum + row.time.monthMinutes, 0),
      },
    });
  }));

  app.put('/api/practice/clients/:clientId/engagement', guard, asyncHandler(async (req, res) => {
    const clientId = clientIdFrom(res, req.params.clientId);
    if (!clientId) return res.status(404).json({ error: 'Client not found.' });
    const form = formReader(req.body);
    const feeInr = form.number('feeInr', 'The fee must be zero or more rupees.', { min: 0, optional: true }) ?? 0;
    const billing = form.choice('billing', BILLING, 'monthly');
    const notes = form.text('notes', 1000);
    await pool.query(
      `INSERT INTO ca_engagements (firm_id, client_id, fee_inr, billing, notes) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (firm_id, client_id) DO UPDATE SET fee_inr = EXCLUDED.fee_inr, billing = EXCLUDED.billing, notes = EXCLUDED.notes, updated_at = now()`,
      [currentUser(res).homeOrganizationId, clientId, feeInr, billing, notes],
    );
    return res.json({ feeInr, billing, notes });
  }));

  app.get('/api/practice/time', guard, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const clientId = req.query.clientId ? clientIdFrom(res, req.query.clientId) : null;
    if (req.query.clientId && !clientId) return res.status(404).json({ error: 'Client not found.' });
    const result = await pool.query<{ id: string; client_id: string; client_name: string; user_email: string; work_date: string; minutes: number; task: string; billable: boolean }>(
      `SELECT t.id, t.client_id, o.name AS client_name, t.user_email, to_char(t.work_date, 'YYYY-MM-DD') AS work_date, t.minutes, t.task, t.billable
       FROM ca_time_entries t JOIN organizations o ON o.id = t.client_id
       WHERE t.firm_id = $1 AND ($2::uuid IS NULL OR t.client_id = $2) AND t.client_id = ANY($3::uuid[])
       ORDER BY t.work_date DESC, t.created_at DESC LIMIT 500`,
      [user.homeOrganizationId, clientId, (res.locals.practiceClients as Array<{ id: string }>).map((client) => client.id)],
    );
    return res.json({
      entries: result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        userEmail: row.user_email,
        workDate: row.work_date,
        minutes: row.minutes,
        task: row.task,
        billable: row.billable,
      })),
    });
  }));

  app.post('/api/practice/time', guard, asyncHandler(async (req, res) => {
    const form = formReader(req.body);
    const clientId = clientIdFrom(res, form.text('clientId', 40));
    if (!clientId) return res.status(400).json({ error: 'Choose the client.' });
    const user = currentUser(res);
    const minutes = form.number('minutes', 'Enter the time spent, from 1 minute to 24 hours.', { min: 1, max: 1440, places: 0 }) as number;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO ca_time_entries (firm_id, client_id, user_id, user_email, work_date, minutes, task, billable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.homeOrganizationId, clientId, user.id, user.email, form.date('workDate', 'Enter the date as YYYY-MM-DD.', true) ?? isoToday(),
        minutes, form.required('task', 'Say what the time was spent on.', 300), form.raw.billable === undefined ? true : form.flag('billable')],
    );
    return res.status(201).json({ id: inserted.rows[0].id });
  }));

  app.delete('/api/practice/time/:id', guard, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Entry not found.' });
    const deleted = await pool.query('DELETE FROM ca_time_entries WHERE id = $1 AND firm_id = $2', [req.params.id, currentUser(res).homeOrganizationId]);
    if (!deleted.rowCount) return res.status(404).json({ error: 'Entry not found.' });
    return res.json({ deleted: true });
  }));

  app.get('/api/practice/bills', guard, asyncHandler(async (_req, res) => {
    const result = await pool.query<{ id: string; client_id: string; client_name: string; bill_no: string; bill_date: string; amount_inr: string; paid_on: string | null; notes: string }>(
      `SELECT b.id, b.client_id, o.name AS client_name, b.bill_no, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date, b.amount_inr,
              to_char(b.paid_on, 'YYYY-MM-DD') AS paid_on, b.notes
       FROM ca_fee_bills b JOIN organizations o ON o.id = b.client_id
       WHERE b.firm_id = $1 AND b.client_id = ANY($2::uuid[])
       ORDER BY (b.paid_on IS NOT NULL), b.bill_date DESC LIMIT 500`,
      [currentUser(res).homeOrganizationId, (res.locals.practiceClients as Array<{ id: string }>).map((client) => client.id)],
    );
    const today = isoToday();
    return res.json({
      bills: result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        billNo: row.bill_no,
        billDate: row.bill_date,
        amountInr: money(row.amount_inr),
        paidOn: row.paid_on,
        daysUnpaid: row.paid_on ? null : Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.bill_date}T00:00:00Z`)) / 86_400_000),
        notes: row.notes,
      })),
    });
  }));

  app.post('/api/practice/bills', guard, asyncHandler(async (req, res) => {
    const form = formReader(req.body);
    const clientId = clientIdFrom(res, form.text('clientId', 40));
    if (!clientId) return res.status(400).json({ error: 'Choose the client.' });
    const firmId = currentUser(res).homeOrganizationId;
    const billNo = form.required('billNo', 'Enter the bill number.', 50);
    try {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO ca_fee_bills (firm_id, client_id, bill_no, bill_date, amount_inr, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [firmId, clientId, billNo, form.date('billDate', 'Enter the bill date as YYYY-MM-DD.', true) ?? isoToday(),
          form.number('amountInr', 'Enter the bill amount in rupees.', { min: 0.01 }), form.text('notes', 500)],
      );
      return res.status(201).json({ id: inserted.rows[0].id });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: `Bill ${billNo} already exists.` });
      throw error;
    }
  }));

  app.post('/api/practice/bills/:id/paid', guard, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Bill not found.' });
    const paidOn = req.body?.paid === false ? null : formReader(req.body).date('paidOn', 'Enter the date paid as YYYY-MM-DD.', true) ?? isoToday();
    const updated = await pool.query('UPDATE ca_fee_bills SET paid_on = $3 WHERE id = $1 AND firm_id = $2', [req.params.id, currentUser(res).homeOrganizationId, paidOn]);
    if (!updated.rowCount) return res.status(404).json({ error: 'Bill not found.' });
    return res.json({ paidOn });
  }));

  app.delete('/api/practice/bills/:id', guard, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Bill not found.' });
    const deleted = await pool.query('DELETE FROM ca_fee_bills WHERE id = $1 AND firm_id = $2', [req.params.id, currentUser(res).homeOrganizationId]);
    if (!deleted.rowCount) return res.status(404).json({ error: 'Bill not found.' });
    return res.json({ deleted: true });
  }));
}
