import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, errorMessage, sendJson, type PaymentGateway } from '../../api/client';
import { Badge, useReport } from '../../components/shared';
import { Card, Field, Notice, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

/** Connects the company's own Razorpay account, so buyers can pay invoices from the portal by UPI, card or net
 * banking. The money goes straight to that account. Only company admins see this. */
export const PaymentGatewaySettings: React.FC = () => {
  const { data, error, setError, reload } = useReport<PaymentGateway>('/api/payment-gateway', 'Could not load the payment settings.');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [inrRate, setInrRate] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (data?.connected) {
      setKeyId(data.keyId);
      setInrRate(data.inrRate === null ? '' : String(data.inrRate));
      setEnabled(data.enabled);
    }
  }, [data]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api<PaymentGateway>('/api/payment-gateway', sendJson('PUT', { keyId: keyId.trim(), keySecret, webhookSecret, inrRate: inrRate.trim(), enabled }));
      setKeySecret('');
      setWebhookSecret('');
      setMessage('Saved. Razorpay accepted the keys.');
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the Razorpay keys.'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Razorpay? Buyers will only be able to pay by bank transfer.')) return;
    setBusy(true);
    try {
      await api('/api/payment-gateway', sendJson('DELETE'));
      setKeyId('');
      setInrRate('');
      setMessage('Disconnected.');
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not disconnect.'));
    } finally {
      setBusy(false);
    }
  };

  const connected = data?.connected ? data : null;

  return (
    <Card title="Online payments from buyers">
      <p className="text-sm text-slate-600 max-w-3xl">
        Connect your company&apos;s own Razorpay account and buyers can pay invoices from their portal link by UPI, debit or credit card, or net
        banking, in rupees. The money goes straight to your Razorpay account and each payment is recorded on its invoice. Buyers can always pay
        by bank transfer too; you confirm those under Buyers.
      </p>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && (
        <div className="mt-3">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      {data && !data.encryptionReady && (
        <div className="mt-3">
          <Notice tone="error">The server needs ENCRYPTION_KEY set before Razorpay keys can be stored. Ask whoever runs this site.</Notice>
        </div>
      )}

      {connected && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={connected.enabled ? 'green' : 'slate'}>{connected.enabled ? 'Taking payments' : 'Switched off'}</Badge>
          <Badge tone={connected.mode === 'live' ? 'green' : 'amber'}>{connected.mode === 'live' ? 'Live keys' : 'Test keys: no real money'}</Badge>
          {!connected.webhookSecretSet && <Badge tone="amber">Webhook secret not set</Badge>}
        </div>
      )}

      <form onSubmit={save} className="mt-4 grid gap-3 md:grid-cols-2 max-w-3xl">
        <Field label="Key ID (rzp_live_… or rzp_test_…)" value={keyId} onChange={setKeyId} required autoComplete="off" />
        <Field
          label={connected ? 'Key secret (leave blank to keep the saved one)' : 'Key secret'}
          type="password"
          value={keySecret}
          onChange={setKeySecret}
          required={!connected}
          autoComplete="new-password"
        />
        <Field
          label={connected?.webhookSecretSet ? 'Webhook secret (leave blank to keep)' : 'Webhook secret'}
          type="password"
          value={webhookSecret}
          onChange={setWebhookSecret}
          autoComplete="new-password"
        />
        <Field label="Rupees per USD for buyers (blank: the day's rate)" value={inrRate} onChange={setInrRate} placeholder="e.g. 84.50" />
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Let buyers pay online
        </label>
        <div className="md:col-span-2 flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !data?.encryptionReady} className={primaryButton}>
            {busy ? 'Checking with Razorpay…' : connected ? 'Save' : 'Connect Razorpay'}
          </button>
          {connected && (
            <button type="button" disabled={busy} onClick={disconnect} className={dangerButton}>
              Disconnect
            </button>
          )}
        </div>
      </form>

      {connected && (
        <div className="mt-4 rounded-lg border border-stone-200 bg-slate-50 p-3 text-sm max-w-3xl">
          <p className="font-semibold">Webhook: records payments even if a buyer closes the page</p>
          <p className="mt-1 text-slate-600">
            In the Razorpay Dashboard, open Account &amp; Settings → Webhooks, add this URL, choose the events <code>payment.captured</code> and{' '}
            <code>order.paid</code>, and enter the same secret here.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white border border-stone-200 px-2 py-1 text-xs">{connected.webhookUrl}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(connected.webhookUrl)} className={secondaryButton}>
              <Copy className="w-3.5 h-3.5" /> Copy
            </button>
          </div>
        </div>
      )}
    </Card>
  );
};
