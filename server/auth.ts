import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, requireUser, type CurrentUser, type Role } from './http.js';
import type { SendPasswordResetEmail } from './mailer.js';

export { requireUser } from './http.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  organization_id: string;
  organization_name: string;
  role: Role;
};

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

function readPassword(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function publicUser(user: CurrentUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    organizationName: user.organizationName,
  };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function appBaseUrl(req: Request): string {
  const configured = process.env.APP_URL;
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

async function findUser(pool: DbPool, where: 'id' | 'email', value: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.organization_id, u.role, o.name AS organization_name
     FROM users u
     JOIN organizations o ON o.id = u.organization_id
     WHERE u.${where} = $1`,
    [value],
  );
  return result.rows[0];
}

function toCurrentUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    email: row.email,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    role: row.role === 'member' ? 'member' : 'admin',
  };
}

async function startSession(req: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      req.session.userId = userId;
      req.session.save((saveError) => {
        if (saveError) reject(saveError);
        else resolve();
      });
    });
  });
}

export function loadUser(pool: DbPool) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (req.session.userId) {
      const row = await findUser(pool, 'id', req.session.userId);
      if (row) res.locals.user = toCurrentUser(row);
    }
    next();
  });
}

export function registerAuthRoutes(
  app: Express,
  pool: DbPool,
  sendResetEmail: SendPasswordResetEmail,
): void {
  app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = readPassword(req.body?.password);
    const companyName =
      typeof req.body?.companyName === 'string' && req.body.companyName.trim()
        ? req.body.companyName.trim().slice(0, 200)
        : email.split('@')[0];

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      const org = await client.query<{ id: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
        [companyName],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, 'admin')
         RETURNING id`,
        [email, passwordHash, org.rows[0].id],
      );
      await client.query('COMMIT');
      userId = inserted.rows[0].id;
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }
      throw error;
    } finally {
      client.release();
    }

    await startSession(req, userId);
    const user = await findUser(pool, 'id', userId);
    return res.status(201).json({ user: publicUser(toCurrentUser(user!)) });
  }));

  app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = readPassword(req.body?.password);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await findUser(pool, 'email', email);
    const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !matches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    await startSession(req, user.id);
    return res.json({ user: publicUser(toCurrentUser(user)) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        return res.status(500).json({ error: 'Could not sign out.' });
      }
      res.clearCookie('connect.sid');
      return res.json({ success: true });
    });
  });

  app.get('/api/auth/me', requireUser, (_req, res) => {
    res.json({ user: publicUser(currentUser(res)) });
  });

  app.post('/api/auth/change-password', requireUser, asyncHandler(async (req, res) => {
    const user = currentUser(res);
    const currentPassword = readPassword(req.body?.currentPassword);
    const newPassword = readPassword(req.body?.newPassword);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const row = await findUser(pool, 'id', user.id);
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, passwordHash]);
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [user.id, req.sessionID]);
    return res.json({ success: true });
  }));

  app.post('/api/auth/forgot-password', asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const message = 'If that email has an account, a reset link has been sent.';
    if (!isValidEmail(email)) {
      return res.json({ success: true, message });
    }

    const user = await findUser(pool, 'email', email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [hashToken(token), user.id, new Date(Date.now() + RESET_TOKEN_TTL_MS)],
      );
      const link = `${appBaseUrl(req)}/?reset=${token}`;
      try {
        await sendResetEmail(user.email, link);
      } catch (error) {
        console.error('Password reset email failed:', error);
      }
    }
    return res.json({ success: true, message });
  }));

  app.post('/api/auth/reset-password', asyncHandler(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = readPassword(req.body?.password);

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const found = await pool.query<{ user_id: string }>(
      `UPDATE password_reset_tokens
       SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(token)],
    );
    const userId = found.rows[0]?.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [userId]);
    return res.json({ success: true });
  }));
}
