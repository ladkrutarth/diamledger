import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy, jsonBodyParser, securityHeaders } from './security.js';

const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

function directives(policy: string): string[] {
  return policy.split(';').map((part) => part.trim());
}

function testApp() {
  const app = express();
  app.use(securityHeaders());
  app.use(jsonBodyParser());
  app.post(['/api/auth/login', '/api/send-email'], (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ type: error.type });
  });
  return app;
}

describe('security headers and body limits', () => {
  it('sends the content security policy and HSTS in production', async () => {
    process.env.NODE_ENV = 'production';
    const response = await request(testApp()).post('/api/auth/login').send({ email: 'a@b.co' });
    expect(directives(response.headers['content-security-policy'])).toEqual(directives(contentSecurityPolicy()));
    expect(response.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps vercel.json headers in sync with the server policy', () => {
    const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    const headers = Object.fromEntries(
      config.headers[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]),
    );
    expect(headers['Content-Security-Policy']).toBe(contentSecurityPolicy());
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('rejects bodies over 1 MB except on upload and email routes', async () => {
    const twoMegabytes = { data: 'x'.repeat(2 * 1024 * 1024) };
    const app = testApp();

    const login = await request(app).post('/api/auth/login').send(twoMegabytes);
    expect(login.status).toBe(413);
    expect(login.body.type).toBe('entity.too.large');

    const email = await request(app).post('/api/send-email').send(twoMegabytes);
    expect(email.status).toBe(200);
  });
});
