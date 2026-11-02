import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { isValidEmail, MIN_PASSWORD_LENGTH, normalizeEmail } from './auth.js';
import { asyncHandler, currentUser, isRole, isUuid, requireAdmin, type Role } from '../../core/http.js';

type MemberRow = { id: string; email: string; role: string; created_at: Date };

function toMember(row: MemberRow) {
  return { id: row.id, email: row.email, role: row.role, createdAt: new Date(row.created_at).toISOString() };
}

async function adminCount(pool: DbPool, organizationId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM users WHERE organization_id = $1 AND role = 'admin'`,
    [organizationId],
  );
  return Number(result.rows[0].count);
}

export function registerTeamRoutes(app: Express, pool: DbPool): void {
  app.get('/api/team/members', requireAdmin, asyncHandler(async (_req, res) => {
    const result = await pool.query<MemberRow>(
      'SELECT id, email, role, created_at FROM users WHERE organization_id = $1 ORDER BY created_at',
      [currentUser(res).organizationId],
    );
    return res.json({ members: result.rows.map(toMember) });
  }));

  app.post('/api/team/members', requireAdmin, asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role: Role = isRole(req.body?.role) ? req.body.role : 'member';

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
    }

    try {
      const result = await pool.query<MemberRow>(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, created_at`,
        [email, await bcrypt.hash(password, 10), currentUser(res).organizationId, role],
      );
      return res.status(201).json(toMember(result.rows[0]));
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }
      throw error;
    }
  }));

  app.patch('/api/team/members/:id', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const role = req.body?.role;
    if (!isRole(role)) {
      return res.status(400).json({ error: 'Choose admin, member, tax accountant, or chartered accountant.' });
    }
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Team member not found.' });
    }
    const target = await pool.query<MemberRow>(
      'SELECT id, email, role, created_at FROM users WHERE id = $1 AND organization_id = $2',
      [req.params.id, user.organizationId],
    );
    if (!target.rows[0]) {
      return res.status(404).json({ error: 'Team member not found.' });
    }
    if (target.rows[0].role === 'admin' && role !== 'admin' && (await adminCount(pool, user.organizationId)) <= 1) {
      return res.status(409).json({ error: 'A company needs at least one admin.' });
    }
    const result = await pool.query<MemberRow>(
      'UPDATE users SET role = $3 WHERE id = $1 AND organization_id = $2 RETURNING id, email, role, created_at',
      [req.params.id, user.organizationId, role],
    );
    return res.json(toMember(result.rows[0]));
  }));

  app.delete('/api/team/members/:id', requireAdmin, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    if (req.params.id === user.id) {
      return res.status(409).json({ error: 'You cannot remove your own account.' });
    }
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: 'Team member not found.' });
    }
    const result = await pool.query('DELETE FROM users WHERE id = $1 AND organization_id = $2', [
      req.params.id,
      user.organizationId,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Team member not found.' });
    }
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [req.params.id]);
    return res.status(204).send();
  }));
}
