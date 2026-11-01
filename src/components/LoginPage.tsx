import React, { useState } from 'react';
import { Gem } from 'lucide-react';
import { ApiError, api, type AuthUser } from '../api/client';

interface Props {
  onSuccess: (user: AuthUser) => void;
}

export const LoginPage: React.FC<Props> = ({ onSuccess }) => {
  const [mode, setMode] = useState<'sign-in' | 'create-account'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isCreate = mode === 'create-account';

  const signIn = async (nextEmail: string, nextPassword: string, path: '/api/auth/login' | '/api/auth/register') => {
    setError('');
    setSubmitting(true);
    try {
      const result = await api<{ user: AuthUser }>(path, {
        method: 'POST',
        body: JSON.stringify({ email: nextEmail, password: nextPassword }),
      });
      onSuccess(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextEmail = String(data.get('email') || email);
    const nextPassword = String(data.get('password') || password);
    await signIn(nextEmail, nextPassword, isCreate ? '/api/auth/register' : '/api/auth/login');
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-white">
            <Gem className="w-4 h-4 text-sky-400" />
          </div>
          <span className="text-base font-bold tracking-tight text-slate-950">DiamondX-A1005</span>
        </div>

        <h1 className="text-xl font-bold text-slate-950">
          {isCreate ? 'Create an account' : 'Sign in'}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {isCreate
            ? 'Save commercial invoices to your account.'
            : 'Open your saved commercial invoices.'}
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-slate-700 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={isCreate ? 'new-password' : 'current-password'}
              required
              minLength={isCreate ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-slate-900 text-white text-sm font-semibold py-2.5 hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? 'Please wait...' : isCreate ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {!isCreate && (
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
          onClick={() => {
            setMode(isCreate ? 'sign-in' : 'create-account');
            setError('');
          }}
          className="mt-4 text-sm font-semibold text-slate-700 hover:text-slate-950"
        >
          {isCreate ? 'Already have an account? Sign in' : 'Need an account? Create one'}
        </button>
      </div>
    </div>
  );
};
