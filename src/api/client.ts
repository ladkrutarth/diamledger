export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type AuthUser = {
  id: string;
  email: string;
};

export type InvoiceSummary = {
  id: string;
  invoiceNumber: string;
  updatedAt: string;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  let body: { error?: string } | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.status,
        'The sign-in API is not running on this site. Redeploy the latest code, then set DATABASE_URL and SESSION_SECRET in Vercel.',
      );
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error || 'Request failed.');
  }
  return body as T;
}
