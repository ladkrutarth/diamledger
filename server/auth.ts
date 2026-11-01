import bcrypt from 'bcryptjs';
import type { Express, Request, Response } from 'express';
import type { DbPool } from './db.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
};

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function publicUser(row: Pick<UserRow, 'id' | 'email'>) {
  return { id: row.id, email: row.email };
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

export function requireUser(req: Request, res: Response, next: () => void): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

export function registerAuthRoutes(app: Express, pool: DbPool): void {
  app.post('/api/auth/register', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const inserted = await pool.query<UserRow>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, password_hash`,
        [email, passwordHash],
      );
      const user = inserted.rows[0];
      await startSession(req, user.id);
      return res.status(201).json({ user: publicUser(user) });
    } catch (error: any) {
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }
      console.error('Register error:', error);
      return res.status(500).json({ error: 'Could not create the account.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
      const found = await pool.query<UserRow>(
        'SELECT id, email, password_hash FROM users WHERE email = $1',
        [email],
      );
      const user = found.rows[0];
      const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
      if (!user || !matches) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      await startSession(req, user.id);
      return res.json({ user: publicUser(user) });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Could not sign in.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        return res.status(500).json({ error: 'Could not sign out.' });
      }
      res.clearCookie('connect.sid');
      return res.json({ success: true });
    });
  });

  app.get('/api/auth/me', async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Sign in required.' });
    }
    const found = await pool.query<Pick<UserRow, 'id' | 'email'>>(
      'SELECT id, email FROM users WHERE id = $1',
      [req.session.userId],
    );
    const user = found.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Sign in required.' });
    }
    return res.json({ user: publicUser(user) });
  });
}
