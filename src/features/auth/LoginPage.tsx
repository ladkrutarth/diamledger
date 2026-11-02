import React, { useState } from 'react';
import { Gem } from 'lucide-react';
import { ApiError, api, needsSecondStep, type AuthUser, type LoginResult, type TwoFactorChallenge } from '../../api/client';
import { COMPANY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from '../../brand';

type Mode = 'sign-in' | 'create-account' | 'forgot' | 'reset' | 'two-factor';

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
  'two-factor': { title: 'Enter your sign-in code', subtitle: 'Your account has two-step sign-in turned on.', submit: 'Verify' },
};

/** What to tell the user about where their code comes from. */
export function codeHint(challenge: TwoFactorChallenge, texted: boolean): string {
  if (texted && challenge.phoneHint) return `Enter the 6-digit code we texted to ${challenge.phoneHint}.`;
  if (challenge.methods.includes('app')) return 'Open your authenticator app and enter the 6-digit code it shows for this site.';
  if (challenge.methods.includes('sms')) return 'We will text a 6-digit code to your phone.';
  return 'Enter one of your recovery codes.';
}

const SHOW_DEMO_LOGIN = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGIN === 'true';

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
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const [code, setCode] = useState('');
  const [texted, setTexted] = useState(false);

  const copy = COPY[mode];

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setInfo('');
    setChallenge(null);
    setCode('');
    setTexted(false);
    if (mode === 'reset') onResetFinished?.();
  };

  const sendText = () =>
    run(async () => {
      const result = await api<{ phoneHint: string }>('/api/auth/two-factor/sms', { method: 'POST' });
      setTexted(true);
      setInfo(`Code sent to ${result.phoneHint}.`);
    }, 'Could not send the text message.');

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
      const result = await api<LoginResult>(path, {
        method: 'POST',
        body: JSON.stringify({
          email: nextEmail,
          password: nextPassword,
          ...(path === '/api/auth/register' ? { companyName } : {}),
        }),
      });
      if (needsSecondStep(result)) {
        // The password was right; the session is not signed in until a code is entered.
        setChallenge(result);
        setMode('two-factor');
        setPassword('');
        setCode('');
        setTexted(false);
        if (!result.methods.includes('app') && result.methods.includes('sms')) {
          const sent = await api<{ phoneHint: string }>('/api/auth/two-factor/sms', { method: 'POST' });
          setTexted(true);
          setInfo(`Code sent to ${sent.phoneHint}.`);
        }
        return;
      }
      onSuccess(result.user);
    }, 'Could not sign in.');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextEmail = String(data.get('email') || email);
    const nextPassword = String(data.get('password') || password);

    if (mode === 'two-factor') {
      await run(async () => {
        try {
          const result = await api<{ user: AuthUser }>('/api/auth/two-factor/verify', {
            method: 'POST',
            body: JSON.stringify({ code }),
          });
          onSuccess(result.user);
        } catch (err) {
          if (err instanceof ApiError && err.body?.code === 'two_factor_expired') {
            setMode('sign-in');
            setChallenge(null);
            setCode('');
          }
          throw err;
        }
      }, 'Could not check the code.');
      return;
    }

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

  const needsEmail = mode !== 'reset' && mode !== 'two-factor';
  const needsPassword = mode !== 'forgot' && mode !== 'two-factor';
  const newPassword = mode === 'create-account' || mode === 'reset';

  return (
    <div className="min-h-screen bg-slate-100 text-stone-800 lg:grid lg:grid-cols-2">
      <aside className="hidden lg:flex flex-col justify-between bg-stone-950 text-stone-100 px-12 py-12">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center">
            <Gem className="w-4 h-4 text-amber-200" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">{PRODUCT_NAME}</p>
            <p className="text-xs text-stone-400">{PRODUCT_TAGLINE}</p>
          </div>
        </div>
        <div>
          <p className="text-3xl font-semibold tracking-tight leading-tight">{COMPANY_NAME}</p>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-stone-300">
            Prepare the commercial invoice, see what each buyer still owes, and follow up when a payment is late.
          </p>
        </div>
        <p className="text-xs text-stone-500">Invoices, payments, and collections in one desk.</p>
      </aside>
      <div className="flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-white border border-stone-200 rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-6 lg:hidden">
          <div className="w-8 h-8 rounded-lg bg-stone-950 flex items-center justify-center text-white">
            <Gem className="w-4 h-4 text-amber-200" />
          </div>
          <span className="text-base font-semibold tracking-tight text-stone-950">{PRODUCT_NAME}</span>
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
          {mode === 'two-factor' && challenge && (
            <div>
              <p className="text-sm text-slate-700">{codeHint(challenge, texted)}</p>
              <label htmlFor="code" className="mt-3 block text-xs font-semibold text-slate-700 mb-1">
                Code
              </label>
              <input
                id="code"
                name="code"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={20}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className={`${inputClass} font-mono tracking-widest`}
              />
              <div className="mt-2 flex flex-col items-start gap-1 text-xs">
                {challenge.methods.includes('sms') && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={sendText}
                    className="font-semibold text-slate-600 hover:text-slate-950 disabled:opacity-50"
                  >
                    {texted ? 'Send a new code' : `Text a code to ${challenge.phoneHint ?? 'my phone'} instead`}
                  </button>
                )}
                {challenge.methods.includes('recovery') && (
                  <p className="text-slate-500">Lost your phone? Enter one of your recovery codes instead.</p>
                )}
              </div>
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

        {mode === 'sign-in' && SHOW_DEMO_LOGIN && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Demo accounts</p>
            <p className="mt-1">Password for every demo account: password123</p>
            <p className="mt-1 text-slate-600">Owner, tax accountant, and chartered accountant.</p>
            <div className="mt-2 flex flex-col items-start gap-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => signIn('owner@example.com', 'password123', '/api/auth/login')}
                className="text-sm font-semibold text-slate-950 underline disabled:opacity-50"
              >
                Sign in as owner
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => signIn('tax.desk@example.com', 'password123', '/api/auth/login')}
                className="text-sm font-semibold text-slate-950 underline disabled:opacity-50"
              >
                Sign in as tax accountant
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => signIn('ca.review@example.com', 'password123', '/api/auth/login')}
                className="text-sm font-semibold text-slate-950 underline disabled:opacity-50"
              >
                Sign in as chartered accountant
              </button>
            </div>
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
    </div>
  );
};
