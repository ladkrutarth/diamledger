import type { Express, Request } from 'express';
import type { DbPool } from '../../core/db.js';
import { normalizeEmail } from '../auth/auth.js';
import { asyncHandler, currentUser, isUuid, requireAdmin, requireUser, type Role } from '../../core/http.js';
import { filingSummary } from '../tax/filing.js';
import { realizationRows } from '../tax/realization.js';
import { taxSettings } from '../tax/taxShared.js';

type Company = { id: string; name: string; role: Role; home: boolean };

export type CalendarStatus = 'overdue' | 'due_soon' | 'upcoming' | 'done' | 'action';

export type CalendarItem = {
  organizationId: string;
  organizationName: string;
  kind: 'gstr1' | 'gstr3b' | 'lut' | 'realization' | 'refund' | 'filing';
  title: string;
  dueDate: string | null;
  daysLeft: number | null;
  status: CalendarStatus;
  detail: string;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function statusFor(daysLeft: number, soon: number): CalendarStatus {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= soon) return 'due_soon';
  return 'upcoming';
}

export async function companiesFor(pool: DbPool, userId: string): Promise<Company[]> {
  const result = await pool.query<{ id: string; name: string; role: string; home: boolean }>(
    `SELECT o.id, o.name, u.role, true AS home
     FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE u.id = $1
     UNION ALL
     SELECT o.id, o.name, a.role, false AS home
     FROM organization_access a JOIN organizations o ON o.id = a.organization_id
     WHERE a.user_id = $1
     ORDER BY home DESC, name`,
    [userId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, role: row.role as Role, home: row.home }));
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
}

export async function complianceItems(pool: DbPool, company: { id: string; name: string }, today: Date): Promise<CalendarItem[]> {
  const items: CalendarItem[] = [];
  const todayIso = isoDate(today);
  const base = { organizationId: company.id, organizationName: company.name };
  const closed = await pool.query<{ month: string }>(
    `SELECT to_char(month, 'YYYY-MM') AS month FROM closed_months WHERE organization_id = $1`,
    [company.id],
  );
  const closedMonths = new Set(closed.rows.map((row) => row.month));

  for (const offset of [-1, 0]) {
    const period = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const periodKey = isoDate(period).slice(0, 7);
    const periodName = `${MONTH_NAMES[period.getMonth()]} ${period.getFullYear()}`;
    const dueMonth = new Date(period.getFullYear(), period.getMonth() + 1, 1);
    for (const [kind, day, title] of [['gstr1', 11, 'GSTR-1'], ['gstr3b', 20, 'GSTR-3B']] as const) {
      const dueDate = isoDate(new Date(dueMonth.getFullYear(), dueMonth.getMonth(), day));
      const daysLeft = daysBetween(todayIso, dueDate);
      const booksClosed = closedMonths.has(periodKey);
      items.push({
        ...base,
        kind,
        title: `${title} for ${periodName}`,
        dueDate,
        daysLeft,
        status: booksClosed ? 'done' : statusFor(daysLeft, 7),
        detail: booksClosed
          ? 'The chartered accountant has closed this month.'
          : kind === 'gstr1'
            ? 'Report the export invoices in table 6A.'
            : 'Pay any IGST and file the summary return.',
      });
    }
  }

  const settings = await taxSettings(pool, company.id);
  if (!settings.lutValidUntil) {
    items.push({
      ...base,
      kind: 'lut',
      title: 'Record the LUT validity',
      dueDate: null,
      daysLeft: null,
      status: 'action',
      detail: 'Enter the date the current Letter of Undertaking runs out so the renewal can be tracked.',
    });
  } else {
    const daysLeft = daysBetween(todayIso, settings.lutValidUntil);
    items.push({
      ...base,
      kind: 'lut',
      title: 'Renew the LUT (form GST RFD-11)',
      dueDate: settings.lutValidUntil,
      daysLeft,
      status: statusFor(daysLeft, 45),
      detail: 'Exports without IGST need a valid LUT for the new financial year, filed before 1 April.',
    });
  }

  const realization = await realizationRows(pool, company.id);
  const urgent = realization.rows.filter((row) => row.flag === 'overdue' || row.flag === 'due_soon');
  if (urgent.length) {
    const earliest = urgent.reduce((min, row) => (row.deadline < min.deadline ? row : min));
    const overdue = urgent.filter((row) => row.flag === 'overdue').length;
    items.push({
      ...base,
      kind: 'realization',
      title: `${urgent.length} invoice${urgent.length === 1 ? '' : 's'} near the FEMA realization deadline`,
      dueDate: earliest.deadline,
      daysLeft: earliest.daysLeft,
      status: overdue ? 'overdue' : 'due_soon',
      detail: `${overdue} already past the ${settings.realizationMonths}-month limit. Ask the bank to report realization or seek an extension.`,
    });
  }

  const refunds = await pool.query<{ count: string; earliest: string | null }>(
    `SELECT COUNT(*) AS count, to_char(MIN(window_end), 'YYYY-MM-DD') AS earliest
     FROM (
       SELECT (COALESCE(t.shipping_bill_date, i.invoice_date, i.created_at::date) + interval '2 years')::date AS window_end
       FROM invoices i
       LEFT JOIN invoice_tax t ON t.invoice_id = i.id
       WHERE i.organization_id = $1 AND i.status IN ('issued', 'paid') AND COALESCE(t.export_scheme, 'lut') = 'lut'
     ) w
     WHERE window_end BETWEEN $2::date AND ($2::date + 90)`,
    [company.id, todayIso],
  );
  const refundCount = Number(refunds.rows[0].count);
  if (refundCount && refunds.rows[0].earliest) {
    items.push({
      ...base,
      kind: 'refund',
      title: `ITC refund window closing for ${refundCount} LUT export${refundCount === 1 ? '' : 's'}`,
      dueDate: refunds.rows[0].earliest,
      daysLeft: daysBetween(todayIso, refunds.rows[0].earliest),
      status: 'due_soon',
      detail: 'A refund of unused input tax on these exports has to be claimed within two years of the export date.',
    });
  }

  const lastMonth = isoDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
  const filing = await filingSummary(pool, company.id, lastMonth);
  const problems = filing.rows.filter((row) => !row.ready).length + filing.companyIssues.length;
  if (problems) {
    items.push({
      ...base,
      kind: 'filing',
      title: `${problems} problem${problems === 1 ? '' : 's'} to fix before filing ${lastMonth}`,
      dueDate: null,
      daysLeft: null,
      status: 'action',
      detail: 'Open the filing check to see shipping bill and e-invoice gaps.',
    });
  }
  return items;
}

const STATUS_ORDER: Record<CalendarStatus, number> = { overdue: 0, due_soon: 1, action: 2, upcoming: 3, done: 4 };

export function registerWorkspaceRoutes(app: Express, pool: DbPool): void {
  app.get('/api/workspace/companies', requireUser, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    return res.json({ activeOrganizationId: user.organizationId, companies: await companiesFor(pool, user.id) });
  }));

  app.post('/api/workspace/switch', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const target = req.body?.organizationId;
    const company = (await companiesFor(pool, user.id)).find((entry) => entry.id === target);
    if (!company) return res.status(404).json({ error: 'You do not have access to that company.' });
    req.session.organizationId = company.home ? undefined : company.id;
    await saveSession(req);
    return res.json({
      user: { id: user.id, email: user.email, role: company.role, organizationId: company.id, organizationName: company.name },
    });
  }));

  app.get('/api/workspace/calendar', requireUser, asyncHandler(async (_req, res) => {
    const user = currentUser(res);
    const companies = (await companiesFor(pool, user.id)).filter((company) => company.role !== 'member');
    const today = new Date();
    const items: CalendarItem[] = [];
    for (const company of companies) items.push(...(await complianceItems(pool, company, today)));
    items.sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    return res.json({ today: isoDate(today), companies: companies.map(({ id, name }) => ({ id, name })), items });
  }));

  app.get('/api/team/accountants', requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query<{ user_id: string; email: string; role: string; created_at: Date; firm: string }>(
      `SELECT a.user_id, u.email, a.role, a.created_at, o.name AS firm
       FROM organization_access a
       JOIN users u ON u.id = a.user_id
       JOIN organizations o ON o.id = u.organization_id
       WHERE a.organization_id = $1
       ORDER BY a.created_at`,
      [currentUser(res).organizationId],
    );
    return res.json({
      accountants: result.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        role: row.role,
        firm: row.firm,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  }));

  app.post('/api/team/accountants', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const email = normalizeEmail(req.body?.email);
    const role = req.body?.role === 'tax' ? 'tax' : 'ca';
    const found = await pool.query<{ id: string; organization_id: string }>(
      'SELECT id, organization_id FROM users WHERE email = $1',
      [email],
    );
    const accountant = found.rows[0];
    if (!accountant) {
      return res.status(404).json({ error: 'No account uses that email. Ask the accountant to create their own firm account first.' });
    }
    if (accountant.organization_id === user.organizationId) {
      return res.status(409).json({ error: 'That person is already on your team. Change their role on the team list instead.' });
    }
    await pool.query(
      `INSERT INTO organization_access (user_id, organization_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by`,
      [accountant.id, user.organizationId, role, user.id],
    );
    return res.status(201).json({ userId: accountant.id, email, role });
  }));

  app.delete('/api/team/accountants/:userId', requireAdmin, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(404).json({ error: 'Accountant not found.' });
    const result = await pool.query('DELETE FROM organization_access WHERE user_id = $1 AND organization_id = $2', [
      req.params.userId,
      currentUser(res).organizationId,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Accountant not found.' });
    return res.status(204).send();
  }));
}
