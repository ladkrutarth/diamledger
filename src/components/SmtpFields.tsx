import React, { useState } from 'react';
import { AlertCircle, CheckCircle, RefreshCw, Server, ShieldCheck } from 'lucide-react';

export type SmtpPreset = 'custom' | 'gmail' | 'office365';

export type SmtpConfig = {
  preset: SmtpPreset;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  allowInvalidCertificates: boolean;
};

export const DEFAULT_SMTP: SmtpConfig = {
  preset: 'gmail',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  user: '',
  pass: '',
  allowInvalidCertificates: false,
};

export function smtpPayload(config: SmtpConfig, fromName: string) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    pass: config.pass,
    fromEmail: config.user,
    fromName,
    allowInvalidCertificates: config.allowInvalidCertificates,
  };
}

const PRESETS: Array<[SmtpPreset, string]> = [
  ['gmail', 'Gmail'],
  ['office365', 'Office 365'],
  ['custom', 'Custom SMTP'],
];

interface Props {
  value: SmtpConfig;
  onChange: (value: SmtpConfig) => void;
}

export const SmtpFields: React.FC<Props> = ({ value, onChange }) => {
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ success: boolean; message: string } | null>(null);
  const set = (patch: Partial<SmtpConfig>) => onChange({ ...value, ...patch });

  const handlePresetChange = (preset: SmtpPreset) => {
    if (preset === 'gmail') set({ preset, host: 'smtp.gmail.com', port: 465, secure: true });
    else if (preset === 'office365') set({ preset, host: 'smtp.office365.com', port: 587, secure: false });
    else set({ preset });
  };

  const handleVerifySmtp = async () => {
    setIsVerifying(true);
    setVerifyStatus(null);
    try {
      const response = await fetch('/api/verify-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: value.host,
          port: value.port,
          secure: value.secure,
          user: value.user,
          pass: value.pass,
          allowInvalidCertificates: value.allowInvalidCertificates,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setVerifyStatus({ success: true, message: 'SMTP Handshake Verified (TLS Ready)' });
      } else {
        setVerifyStatus({ success: false, message: data.error || 'SMTP Authentication Failed' });
      }
    } catch (err: any) {
      setVerifyStatus({ success: false, message: err.message || 'Network error verifying SMTP' });
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="p-3 border border-slate-200 rounded-lg bg-slate-50/50 space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-semibold text-slate-900">
          <Server className="w-4 h-4 text-slate-600" />
          <span>SMTP Gateway Configuration</span>
        </div>
        <div className="flex items-center gap-1">
          {PRESETS.map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              onClick={() => handlePresetChange(preset)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                value.preset === preset ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <div className="md:col-span-2">
          <label className="block text-[11px] font-medium text-slate-600 mb-0.5">SMTP Server Host</label>
          <input
            type="text"
            value={value.host}
            onChange={(e) => set({ host: e.target.value })}
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Port & SSL</label>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              value={value.port}
              onChange={(e) => set({ port: parseInt(e.target.value) || 587 })}
              className="w-16 px-2 py-1 border border-slate-300 rounded font-mono bg-white"
            />
            <label className="flex items-center gap-1 text-[11px] text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={value.secure}
                onChange={(e) => set({ secure: e.target.checked })}
                className="rounded text-blue-600"
              />
              <span>SSL/TLS</span>
            </label>
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Action</label>
          <button
            type="button"
            onClick={handleVerifySmtp}
            disabled={isVerifying}
            className="w-full px-2 py-1 text-xs font-medium border border-slate-300 rounded bg-white hover:bg-slate-100 text-slate-700 transition-colors flex items-center justify-center gap-1"
          >
            {isVerifying ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />}
            <span>Test Gateway</span>
          </button>
        </div>
      </div>
      <label className="flex items-start gap-1.5 text-[11px] text-slate-600 cursor-pointer">
        <input
          type="checkbox"
          checked={value.allowInvalidCertificates}
          onChange={(e) => set({ allowInvalidCertificates: e.target.checked })}
          className="mt-0.5 rounded text-blue-600"
        />
        <span>
          Allow a self-signed or invalid TLS certificate. Only use this for a mail server you control: it lets a
          network attacker read your SMTP password.
        </span>
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Username / Sender Email</label>
          <input
            type="text"
            value={value.user}
            onChange={(e) => set({ user: e.target.value })}
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-600 mb-0.5">App Password / Auth Token</label>
          <input
            type="password"
            placeholder="••••••••••••••••"
            value={value.pass}
            onChange={(e) => set({ pass: e.target.value })}
            className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
          />
        </div>
      </div>

      {verifyStatus && (
        <div className={`p-2 rounded text-[11px] flex items-center gap-1.5 ${
          verifyStatus.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'
        }`}>
          {verifyStatus.success ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
          <span>{verifyStatus.message}</span>
        </div>
      )}
    </div>
  );
};
