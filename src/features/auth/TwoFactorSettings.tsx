import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { api, errorMessage, sendJson, type TwoFactorAppSetup, type TwoFactorStatus } from '../../api/client';
import { Card, Field, Notice, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

type Step = 'idle' | 'app' | 'phone-number' | 'phone-code';

/** Recovery codes as a text file to keep somewhere safe. */
export function recoveryFile(codes: string[], email: string): string {
  return [
    `Two-step sign-in recovery codes for ${email}`,
    'Each code works once. Keep them somewhere safe, away from your phone.',
    '',
    ...codes,
    '',
  ].join('\n');
}

/** Two-step sign-in on the Account page: authenticator app, text message, recovery codes. */
export const TwoFactorSettings: React.FC<{ email: string }> = ({ email }) => {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<TwoFactorAppSetup | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<TwoFactorStatus>('/api/auth/two-factor')
      .then(setStatus)
      .catch((err) => setMessage({ tone: 'error', text: errorMessage(err, 'Could not load two-step sign-in.') }));
  }, []);

  const act = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, fallback) });
    } finally {
      setBusy(false);
    }
  };

  const finish = (next: TwoFactorStatus, text: string) => {
    setStatus(next);
    setStep('idle');
    setSetup(null);
    setCode('');
    setPassword('');
    if (next.recoveryCodes) setCodes(next.recoveryCodes);
    setMessage({ tone: 'success', text });
  };

  const startApp = () =>
    act(async () => {
      setSetup(await api<TwoFactorAppSetup>('/api/auth/two-factor/app/setup', sendJson('POST', { password })));
      setStep('app');
      setCode('');
    }, 'Could not start the setup.');

  const confirmApp = (event: React.FormEvent) => {
    event.preventDefault();
    return act(async () => {
      const next = await api<TwoFactorStatus>('/api/auth/two-factor/app/confirm', sendJson('POST', { code }));
      finish(next, 'Authenticator app turned on. You will be asked for a code each time you sign in. Other devices were signed out.');
    }, 'Could not check the code.');
  };

  const sendPhoneCode = (event?: React.FormEvent) => {
    event?.preventDefault();
    return act(async () => {
      const sent = await api<{ phoneHint: string }>('/api/auth/two-factor/phone/setup', sendJson('POST', { password, phone }));
      setStep('phone-code');
      setCode('');
      setMessage({ tone: 'info', text: `Code sent to ${sent.phoneHint}.` });
    }, 'Could not send the code.');
  };

  const confirmPhone = (event: React.FormEvent) => {
    event.preventDefault();
    return act(async () => {
      const next = await api<TwoFactorStatus>('/api/auth/two-factor/phone/confirm', sendJson('POST', { code }));
      finish(next, 'Text message codes turned on. Other devices were signed out.');
    }, 'Could not check the code.');
  };

  const remove = (what: 'app' | 'phone') =>
    act(async () => {
      if (!window.confirm(what === 'app' ? 'Remove the authenticator app?' : 'Stop texting sign-in codes to this phone?')) return;
      const next = await api<TwoFactorStatus>(`/api/auth/two-factor/${what}`, sendJson('DELETE', { password }));
      finish(next, next.enabled ? 'Removed.' : 'Two-step sign-in is off. Your password alone now signs you in.');
    }, 'Could not remove it.');

  const renewCodes = () =>
    act(async () => {
      const next = await api<TwoFactorStatus>('/api/auth/two-factor/recovery-codes', sendJson('POST', { password }));
      finish(next, 'New recovery codes made. The old ones no longer work.');
    }, 'Could not make new codes.');

  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([recoveryFile(codes, email)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!status) {
    return (
      <Card title="Two-step sign-in" className="max-w-xl">
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : <p className="text-sm text-slate-500">Loading…</p>}
      </Card>
    );
  }

  const needPassword = password.length === 0;

  return (
    <Card title="Two-step sign-in" className="max-w-xl">
      <p className="text-sm text-slate-600 flex items-center gap-1.5">
        <ShieldCheck className={`w-4 h-4 ${status.enabled ? 'text-emerald-700' : 'text-slate-400'}`} />
        {status.enabled
          ? 'On. After your password, you enter a code from your phone.'
          : 'Off. Turn it on so a stolen password is not enough to get into your account.'}
      </p>

      {codes && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">Save your recovery codes now</p>
          <p className="mt-1 text-xs text-amber-900">
            If you lose your phone, each code signs you in once. They will not be shown again.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono text-sm">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={download} className={secondaryButton}>
              Download
            </button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))} className={secondaryButton}>
              Copy
            </button>
            <button type="button" onClick={() => setCodes(null)} className={secondaryButton}>
              I have saved them
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}

      {step === 'idle' && (
        <div className="mt-3 max-w-xs">
          <Field
            label="Your password (needed to change these settings)"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
        </div>
      )}

      <div className="mt-4 space-y-4">
        <section className="rounded-lg border border-stone-200 p-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <KeyRound className="w-4 h-4" /> Authenticator app
          </h3>
          <p className="mt-1 text-xs text-slate-500">Google Authenticator, Microsoft Authenticator, Authy, 1Password, or similar. Works offline.</p>
          {status.app ? (
            <div className="mt-2 flex items-center gap-3">
              <span className="text-sm text-emerald-800 font-medium">On</span>
              <button type="button" disabled={busy || needPassword} onClick={() => remove('app')} className={dangerButton}>
                Remove
              </button>
            </div>
          ) : step === 'app' && setup ? (
            <form onSubmit={confirmApp} className="mt-2 space-y-2">
              <p className="text-sm">1. Scan this QR code with the app.</p>
              <img src={setup.qrCode} alt="QR code for the authenticator app" className="w-44 h-44 border border-stone-200 rounded" />
              <p className="text-xs text-slate-500">
                Can&apos;t scan? Enter this key in the app: <span className="font-mono text-slate-800 break-all">{setup.secret}</span>
              </p>
              <p className="text-sm">2. Enter the 6-digit code the app shows.</p>
              <div className="max-w-[10rem]">
                <Field label="Code" value={code} onChange={setCode} required autoComplete="one-time-code" />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={primaryButton}>
                  Turn on
                </button>
                <button type="button" onClick={() => { setStep('idle'); setSetup(null); }} className={secondaryButton}>
                  Cancel
                </button>
              </div>
            </form>
          ) : status.appAvailable ? (
            <button type="button" disabled={busy || needPassword || step !== 'idle'} onClick={startApp} className={`${primaryButton} mt-2`}>
              Set up authenticator app
            </button>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Not available on this server yet (ENCRYPTION_KEY is not set).</p>
          )}
        </section>

        <section className="rounded-lg border border-stone-200 p-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Smartphone className="w-4 h-4" /> Text message (SMS)
          </h3>
          <p className="mt-1 text-xs text-slate-500">A code is texted to your mobile each time you sign in.</p>
          {status.phone ? (
            <div className="mt-2 flex items-center gap-3">
              <span className="text-sm text-emerald-800 font-medium">On · {status.phone}</span>
              <button type="button" disabled={busy || needPassword} onClick={() => remove('phone')} className={dangerButton}>
                Remove
              </button>
            </div>
          ) : !status.smsAvailable ? (
            <p className="mt-2 text-sm text-slate-500">Not available on this server yet. Use an authenticator app.</p>
          ) : step === 'phone-code' ? (
            <form onSubmit={confirmPhone} className="mt-2 space-y-2">
              <div className="max-w-[10rem]">
                <Field label="Code from the text message" value={code} onChange={setCode} required autoComplete="one-time-code" />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={primaryButton}>
                  Turn on
                </button>
                <button type="button" disabled={busy} onClick={() => sendPhoneCode()} className={secondaryButton}>
                  Send a new code
                </button>
                <button type="button" onClick={() => { setStep('idle'); setCode(''); }} className={secondaryButton}>
                  Cancel
                </button>
              </div>
            </form>
          ) : step === 'phone-number' ? (
            <form onSubmit={sendPhoneCode} className="mt-2 space-y-2">
              <div className="max-w-xs">
                <Field label="Mobile number with country code" type="tel" value={phone} onChange={setPhone} required placeholder="+91 98123 45678" autoComplete="tel" />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={primaryButton}>
                  Send code
                </button>
                <button type="button" onClick={() => setStep('idle')} className={secondaryButton}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" disabled={busy || needPassword || step !== 'idle'} onClick={() => setStep('phone-number')} className={`${primaryButton} mt-2`}>
              Add a phone
            </button>
          )}
        </section>

        {status.enabled && (
          <section className="rounded-lg border border-stone-200 p-3">
            <h3 className="text-sm font-semibold">Recovery codes</h3>
            <p className="mt-1 text-xs text-slate-500">
              {status.recoveryCodesLeft} unused. Use one to sign in if you lose your phone.
            </p>
            <button type="button" disabled={busy || needPassword} onClick={renewCodes} className={`${secondaryButton} mt-2`}>
              Make new recovery codes
            </button>
          </section>
        )}
      </div>
    </Card>
  );
};
