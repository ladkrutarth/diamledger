import { describe, expect, it } from 'vitest';
import { apiUrl } from '../vercelHandler.js';

describe('apiUrl', () => {
  it('restores the original API path from the Vercel rewrite', () => {
    expect(apiUrl('/api/index?__path=auth/login')).toBe('/api/auth/login');
    expect(apiUrl('/api/index?__path=invoices%2Fabc%2Fpayments&status=paid')).toBe(
      '/api/invoices/abc/payments?status=paid',
    );
  });

  it('keeps direct API paths and their queries', () => {
    expect(apiUrl('/api/invoices/export?q=dubai')).toBe('/api/invoices/export?q=dubai');
  });
});
