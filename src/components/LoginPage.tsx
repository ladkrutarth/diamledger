import React, { useState } from 'react';
import { Gem } from 'lucide-react';
import { ApiError, api, type AuthUser } from '../api/client';

type Mode = 'sign-in' | 'create-account' | 'forgot' | 'reset';

interface Props {
  onSuccess: (user: AuthUser) => void;
  resetToken?: string | null;
  onResetFinished?: () => void;
}

const COPY: Record<Mode, { title: string; subtitle: string; submit: string }> = {
  'sign-in': { title: 'Sign in', subtitle: 'Open your saved commercial invoices.', submit: 'Sign in' },
  'create-account': {
    title: 'Create an account',
    subtitle: 'Set up your company. You can invite your team later.',
    submit: 'Create account',
  },
  forgot: {
    title: 'Reset your password',
    subtitle: 'Enter your email and we will send you a reset link.',
    submit: 'Send reset link',
  },
  reset: { title: 'Choose a new password', subtitle: 'The link works once and expires after 1 hour.', submit: 'Save new password' },
};

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900';

export const LoginPage: React.FC<Props> = ({ onSuccess, resetToken, onResetFinished }) => {
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const copy = COPY[mode];

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setInfo('');
    if (mode === 'reset') onResetFinished?.();
  };

  const run = async (action: () => Promise<void>, fallback: string) => {
    setError('');
    setInfo('');
    setSubmitting(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setSubmitting(false);
    }
  };

  const signIn = (nextEmail: string, nextPassword: string, path: '/api/auth/login' | '/api/auth/register') =>
    run(async () => {
      const result = await api<{ user: AuthUser }>(path, {
        method: 'POST',
        body: JSON.stringify({
          email: nextEmail,
          password: nextPassword,
          ...(path === '/api/auth/register' ? { companyName } : {}),
        }),
      });
      onSuccess(result.user);
    }, 'Could not sign in.');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextEmail = String(data.get('email') || email);
    const nextPassword = String(data.get('password') || password);

    if (mode === 'forgot') {
      await run(async () => {
        const result = await api<{ message: string }>('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: nextEmail }),
        });
        setInfo(result.message);
      }, 'Could not send the reset link.');
      return;
    }

    if (mode === 'reset') {
      await run(async () => {
        await api('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token: resetToken, password: nextPassword }),
        });
        onResetFinished?.();
        setMode('sign-in');
        setPassword('');
        setInfo('Password changed. Sign in with your new password.');
      }, 'Could not reset the password.');
      return;
    }

    await signIn(nextEmail, nextPassword, mode === 'create-account' ? '/api/auth/register' : '/api/auth/login');
  };

  const needsEmail = mode !== 'reset';
  const needsPassword = mode !== 'forgot';
  const newPassword = mode === 'create-account' || mode === 'reset';

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-white">
            <Gem className="w-4 h-4 text-sky-400" />
          </div>
          <span className="text-base font-bold tracking-tight text-slate-950">DiamondX-A1005</span>
        </div>

        <h1 className="text-xl font-bold text-slate-950">{copy.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{copy.subtitle}</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {mode === 'create-account' && (
            <div>
              <label htmlFor="companyName" className="block text-xs font-semibold text-slate-700 mb-1">
                Company name
              </label>
              <input
                id="companyName"
                name="companyName"
                autoComplete="organization"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                className={inputClass}
              />
            </div>
          )}
          {needsEmail && (
            <div>
              <label htmlFor="email" className="block text-xs font-semibold text-slate-700 mb-1">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </div>
          )}
          {needsPassword && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="block text-xs font-semibold text-slate-700">
                  {mode === 'reset' ? 'New password' : 'Password'}
                </label>
                {mode === 'sign-in' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="text-xs font-semibold text-slate-600 hover:text-slate-950"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={newPassword ? 'new-password' : 'current-password'}
                required
                minLength={newPassword ? 8 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {info && (
            <p role="status" className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {info}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 text-white text-sm font-semibold py-2.5 hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? 'Please wait...' : copy.submit}
          </button>
        </form>

        {mode === 'sign-in' && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Demo account</p>
            <p className="mt-1">Email: owner@example.com</p>
            <p>Password: password123</p>
            <button
              type="button"
              disabled={submitting}
              onClick={() => signIn('owner@example.com', 'password123', '/api/auth/login')}
              className="mt-2 text-sm font-semibold text-slate-950 underline disabled:opacity-50"
            >
              Sign in with the demo account
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => switchMode(mode === 'sign-in' ? 'create-account' : 'sign-in')}
          className="mt-4 text-sm font-semibold text-slate-700 hover:text-slate-950"
        >
          {mode === 'sign-in' ? 'Need an account? Create one' : 'Back to sign in'}
        </button>
      </div>
    </div>
  );
};
