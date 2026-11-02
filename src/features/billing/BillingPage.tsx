import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { api, errorMessage, sendJson, type BillingCycle, type BillingPlan, type BillingSummary, type CheckoutStart } from '../../api/client';
import { Badge, TableHead, cell, useReport } from '../../components/shared';
import { Card, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

const rupees = (value: number) => `₹${value.toLocaleString('en-IN')}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

type RazorpayResponse = { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string };
type RazorpayInstance = { open: () => void; on: (event: string, handler: (response: { error?: { description?: string } }) => void) => void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

/** Loads Razorpay Checkout once. Allowed by the Content Security Policy in server/core/security.ts. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.'));
    document.body.appendChild(script);
  });
}

const ACCESS: Record<BillingSummary['access'], { tone: 'green' | 'amber' | 'red'; label: string }> = {
  trial: { tone: 'amber', label: 'Free trial' },
  active: { tone: 'green', label: 'Active' },
  grace: { tone: 'amber', label: 'Payment due' },
  lapsed: { tone: 'red', label: 'Ended' },
};

const Usage: React.FC<{ label: string; used: number; limit: number | null }> = ({ label, used, limit }) => {
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {limit === null ? 'unlimited' : limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-slate-100">
        <div className={`h-1.5 rounded-full ${percent >= 90 ? 'bg-red-600' : 'bg-slate-900'}`} style={{ width: `${limit === null ? 0 : percent}%` }} />
      </div>
    </div>
  );
};

export const BillingPage: React.FC<{ isAdmin: boolean; onChanged?: () => void }> = ({ isAdmin, onChanged }) => {
  const summary = useReport<BillingSummary>('/api/billing', 'Could not load your plan.');
  const catalogue = useReport<{ plans: BillingPlan[]; trialDays: number; paymentsEnabled: boolean }>('/api/billing/plans', 'Could not load the plans.');
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const current = summary.data;

  const subscribe = async (plan: BillingPlan) => {
    setBusy(plan.key);
    setError('');
    setMessage('');
    try {
      const start = await api<CheckoutStart>('/api/billing/checkout', sendJson('POST', { plan: plan.key, cycle }));
      await loadCheckout();
      const checkout = new window.Razorpay!({
        key: start.keyId,
        subscription_id: start.subscriptionId,
        name: start.name,
        description: start.description,
        prefill: start.prefill,
        theme: { color: '#0f172a' },
        handler: async (response: RazorpayResponse) => {
          try {
            await api('/api/billing/verify', sendJson('POST', response));
            setMessage(`You are on ${plan.name}, billed ${cycle}. A receipt is on its way from Razorpay.`);
            summary.reload();
            onChanged?.();
          } catch (err) {
            setError(errorMessage(err, 'The payment went through but could not be confirmed yet. It will show here within a few minutes.'));
          } finally {
            setBusy('');
          }
        },
        modal: { ondismiss: () => setBusy('') },
      });
      checkout.on('payment.failed', (response) => {
        setError(response.error?.description ?? 'The payment failed. No money was taken.');
        setBusy('');
      });
      checkout.open();
    } catch (err) {
      setError(errorMessage(err, err instanceof Error ? err.message : 'Could not start checkout.'));
      setBusy('');
    }
  };

  const cancel = async () => {
    if (!window.confirm('Turn off renewal? The plan keeps working until the end of the period you have paid for.')) return;
    setBusy('cancel');
    try {
      await api('/api/billing/cancel', sendJson('POST'));
      setMessage('Renewal is off. Choose a plan again any time to keep going.');
      summary.reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel the plan.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Page
      title="Plan & billing"
      description="Monthly or yearly plans in Indian rupees. Prices are per company and exclude 18% GST, which is added at checkout. Pay by UPI, card, or net banking through Razorpay; plans renew automatically and can be stopped any time."
    >
      {(error || summary.error || catalogue.error) && <Notice tone="error">{error || summary.error || catalogue.error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}

      {current && (
        <Card title="Your plan">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-slate-950">
                {current.planName} <Badge tone={ACCESS[current.access].tone}>{ACCESS[current.access].label}</Badge>
              </p>
              <p className="text-sm text-slate-600 mt-1">
                {current.access === 'trial' && `${current.daysLeft} day${current.daysLeft === 1 ? '' : 's'} left, ends ${date(current.trialEndsAt)}. Every feature is open during the trial.`}
                {current.access === 'active' &&
                  (current.cancelAtPeriodEnd
                    ? `Renewal is off. Works until ${date(current.currentPeriodEnd)}.`
                    : `Billed ${current.cycle}. Renews ${date(current.currentPeriodEnd)}.`)}
                {current.access === 'grace' && 'The last renewal payment did not go through. Razorpay is retrying; update your payment method from the Razorpay email to avoid interruption.'}
                {current.access === 'lapsed' && 'This company is read-only. Choose a plan below to keep working; nothing has been deleted.'}
              </p>
            </div>
            {isAdmin && current.planKey !== 'trial' && current.access !== 'lapsed' && !current.cancelAtPeriodEnd && (
              <button type="button" disabled={busy !== ''} onClick={cancel} className={dangerButton}>
                Turn off renewal
              </button>
            )}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Usage label="Users" used={current.usage.users} limit={current.limits.users} />
            <Usage label="Invoices issued this month" used={current.usage.invoicesThisMonth} limit={current.limits.invoicesPerMonth} />
            {current.limits.clients !== null && <Usage label="Client companies" used={current.usage.clients} limit={current.limits.clients} />}
          </div>
        </Card>
      )}

      {catalogue.data && !catalogue.data.paymentsEnabled && (
        <Notice>Online payment is not switched on for this site yet. Plans are shown for reference; ask the site owner to add the Razorpay keys.</Notice>
      )}
      {!isAdmin && <Notice>Only a company admin can change the plan.</Notice>}

      <div className="flex items-center gap-1">
        {(['monthly', 'yearly'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setCycle(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${cycle === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'}`}
          >
            {key === 'monthly' ? 'Monthly' : 'Yearly · 2 months free'}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {catalogue.data?.plans.map((plan) => {
          const price = plan.prices[cycle];
          const isCurrent = current?.planKey === plan.key && current.cycle === cycle && current.access !== 'lapsed' && !current.cancelAtPeriodEnd;
          return (
            <section key={plan.key} className={`flex flex-col bg-white border rounded-xl p-4 ${plan.key === 'growth' ? 'border-slate-900' : 'border-stone-200'}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-950">{plan.name}</h2>
                {plan.key === 'growth' && <Badge tone="slate">Most chosen</Badge>}
              </div>
              <p className="text-xs text-slate-500">{plan.audience}</p>
              <p className="mt-3 text-2xl font-semibold tabular-nums text-slate-950">
                {rupees(cycle === 'monthly' ? plan.monthlyInr : plan.yearlyInr)}
                <span className="text-sm font-normal text-slate-500"> / {cycle === 'monthly' ? 'month' : 'year'}</span>
              </p>
              <p className="text-xs text-slate-500">
                + 18% GST {rupees(price.gstInr)} = {rupees(price.totalInr)}
                {cycle === 'yearly' && ` · save ${rupees(plan.yearlySavingInr)}`}
                {cycle === 'yearly' && ` · ${rupees(Math.round(plan.yearlyInr / 12))}/month`}
              </p>
              <ul className="mt-3 space-y-1.5 text-sm text-slate-700 flex-1">
                {plan.highlights.map((line) => (
                  <li key={line} className="flex gap-1.5">
                    <Check className="w-4 h-4 shrink-0 text-emerald-700 mt-0.5" />
                    {line}
                  </li>
                ))}
              </ul>
              {isAdmin && (
                <button
                  type="button"
                  disabled={busy !== '' || isCurrent || !catalogue.data?.paymentsEnabled}
                  onClick={() => subscribe(plan)}
                  className={`${plan.key === 'growth' ? primaryButton : secondaryButton} mt-4 justify-center`}
                >
                  {isCurrent ? 'Current plan' : busy === plan.key ? 'Opening checkout...' : `Choose ${plan.name}`}
                </button>
              )}
            </section>
          );
        })}
      </div>

      <Card title="Questions">
        <div className="grid gap-3 sm:grid-cols-2 text-sm text-slate-700">
          <p><strong>Is GST charged?</strong> Yes, 18% on the plan price, shown before you pay. The Razorpay receipt shows the amount paid.</p>
          <p><strong>Can I change plans?</strong> Yes. The new plan starts as soon as it is paid, and the old one stops renewing.</p>
          <p><strong>What if a renewal fails?</strong> Razorpay retries. You keep working for 3 days after the period ends; then the company is read-only until a plan is paid.</p>
          <p><strong>Does my CA need a plan?</strong> A CA works in your company on your plan. A firm with many clients takes the CA Firm plan for its practice view.</p>
        </div>
      </Card>

      {current && current.payments.length > 0 && (
        <Card title="Payments">
          <table className="w-full text-sm">
            <TableHead labels={['Date', 'Plan', 'Amount', 'Method', 'Status']} />
            <tbody>
              {current.payments.map((payment) => (
                <tr key={payment.id}>
                  <td className={cell}>{date(payment.paidAt)}</td>
                  <td className={`${cell} capitalize`}>
                    {payment.planKey.replace('_', ' ')} {payment.cycle ? `(${payment.cycle})` : ''}
                  </td>
                  <td className={`${cell} tabular-nums`}>{rupees(payment.amountInr)}</td>
                  <td className={`${cell} uppercase`}>{payment.method || '—'}</td>
                  <td className={cell}>
                    <Badge tone={payment.status === 'captured' ? 'green' : 'slate'}>{payment.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

    </Page>
  );
};
