// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('submits credentials and shows the server error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ error: 'Invalid email or password.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage onSuccess={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid email or password.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'owner@example.com', password: 'wrong-password' }),
      }),
    );
  });

  it('sends a password reset link', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, message: 'If that email has an account, a reset link has been sent.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage onSuccess={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect((await screen.findByRole('status')).textContent).toContain('reset link has been sent');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/forgot-password',
      expect.objectContaining({ body: JSON.stringify({ email: 'owner@example.com' }) }),
    );
  });

  it('sets a new password from a reset link', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const onResetFinished = vi.fn();

    render(<LoginPage onSuccess={() => undefined} resetToken="abc123" onResetFinished={onResetFinished} />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'brand-new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));

    expect((await screen.findByRole('status')).textContent).toContain('Sign in with your new password');
    expect(onResetFinished).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/reset-password',
      expect.objectContaining({ body: JSON.stringify({ token: 'abc123', password: 'brand-new-pass' }) }),
    );
  });

  it('sends the company name when creating an account', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ user: { id: '1', email: 'a@b.co', role: 'admin' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn();

    render(<LoginPage onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Need an account? Create one' }));
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'xyz LLC' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.co', password: 'password123', companyName: 'xyz LLC' }),
      }),
    );
  });

  it('asks for the two-step code after the password', async () => {
    const user = { id: '1', email: 'owner@example.com', role: 'admin' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ twoFactorRequired: true, methods: ['app', 'sms', 'recovery'], phoneHint: '•••• 5678' }),
      })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ user, method: 'app', recoveryCodesLeft: 10 }) });
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn();

    render(<LoginPage onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter your sign-in code')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Text a code to •••• 5678 instead' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith(user));
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/two-factor/verify',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '123456' }) }),
    );
  });
});
