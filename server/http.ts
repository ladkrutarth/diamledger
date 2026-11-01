import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type Role = 'admin' | 'member';

export type CurrentUser = {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: Role;
};

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function currentUser(res: Response): CurrentUser {
  return res.locals.user as CurrentUser;
}

export function requireUser(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.user) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  const user = res.locals.user as CurrentUser | undefined;
  if (!user) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Only company admins can do this.' });
    return;
  }
  next();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringFields(value: unknown, keys: readonly string[]): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const key of keys) {
    const field = value[key];
    if (field === undefined || field === null) {
      result[key] = '';
    } else if (typeof field === 'string') {
      result[key] = field.slice(0, 500);
    } else {
      return null;
    }
  }
  return result;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
