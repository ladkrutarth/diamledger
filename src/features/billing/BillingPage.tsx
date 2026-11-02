import React, { useEffect, useRef, useState } from 'react';
import { Building, Check, Copy, CreditCard, Globe, Landmark, Smartphone } from 'lucide-react';
import {
  api,
  errorMessage,
  sendJson,
  type BankTransfer,
  type BillingCycle,
  type BillingPlan,
  type BillingSummary,
  type CheckoutStart,
  type PaymentOptions,
  type SellerBankAccount,
} from '../../api/client';
import { Badge, TableHead, cell, useReport } from '../../components/shared';
import { Card, Field, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

const rupees = (value: number) => `₹${value.toLocaleString('en-IN')}`;
const dollars = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

type Method = 'upi' | 'card' | 'netbanking' | 'bank_transfer' | 'paypal';

const METHODS: Array<{ key: Method; option: keyof PaymentOptions; label: string; detail: string; icon: React.ReactNode }> = [
  { key: 'upi', option: 'upi', label: 'UPI', detail: 'UPI AutoPay from any UPI app. Renews automatically.', icon: <Smartphone className="w-4 h-4" /> },
  { key: 'card', option: 'card', label: 'Debit or credit card', detail: 'Visa, Mastercard, RuPay. Renews automatically.', icon: <CreditCard className="w-4 h-4" /> },
  { key: 'netbanking', option: 'netbanking', label: 'Net banking', detail: 'Bank e-mandate. Renews automatically.', icon: <Building className="w-4 h-4" /> },
  { key: 'bank_transfer', option: 'bankTransfer', label: 'Bank transfer', detail: 'NEFT, RTGS, or IMPS to our account. Pays one period; active once we see the credit.', icon: <Landmark className="w-4 h-4" /> },
  { key: 'paypal', option: 'paypal', label: 'PayPal', detail: 'For companies outside India, in US dollars, no GST. Pays one period.', icon: <Globe className="w-4 h-4" /> },
];

/** Razorpay method names, used to show the chosen method first in Checkout. */
const RAZORPAY_METHOD: Partial<Record<Method, string>> = { upi: 'upi', card: 'card', netbanking: 'emandate' };

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

const PROVIDER_LABEL: Record<string, string> = { razorpay: 'Razorpay', bank_transfer: 'Bank transfer', paypal: 'PayPal' };

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

const CopyRow: React.FC<{ label: string; value: string }> = ({ label, value }) =>
  value ? (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-2 font-semibold text-slate-950 tabular-nums">
        {value}
        <button type="button" title={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(value)} className="text-slate-400 hover:text-slate-900">
          <Copy className="w-3.5 h-3.5" />
        </button>
      </span>
    </div>
  ) : null;

/** Step 2 of a bank transfer: our account details, then the UTR once the company has paid. */
const BankTransferCard: React.FC<{ transfer: BankTransfer; account: SellerBankAccount | null; onChanged: () => void }> = ({ transfer, account, onChanged }) => {
  const [utr, setUtr] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [payerBank, setPayerBank] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/billing/bank-transfer/${transfer.id}/submit`, sendJson('POST', { utr, paidOn, payerBank }));
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not send the transfer details.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await api(`/api/billing/bank-transfer/${transfer.id}/cancel`, sendJson('POST'));
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel the transfer.'));
    }
  };

  return (
    <Card title={`Bank transfer for ${transfer.planName} (${transfer.cycle})`}>
      {transfer.status === 'submitted' ? (
        <Notice>
          We have your transfer of {rupees(transfer.amountInr)} with UTR {transfer.utr}, paid {transfer.paidOn}. The plan switches on as soon as we see the
          credit, usually within one working day.
        </Notice>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <p className="text-sm text-slate-700 mb-2">
              1. Transfer <strong>{rupees(transfer.amountInr)}</strong> (including 18% GST) by NEFT, RTGS, or IMPS, and write the reference in the remarks.
            </p>
            {account ? (
              <div>
                <CopyRow label="Amount" value={String(transfer.amountInr)} />
                <CopyRow label="Reference / remarks" value={transfer.referenceCode} />
                <CopyRow label="Account name" value={account.accountName} />
                <CopyRow label="Account number" value={account.accountNumber} />
                <CopyRow label="IFSC" value={account.ifsc} />
                <CopyRow label="Bank" value={account.bankName} />
                <CopyRow label="Branch" value={account.branch} />
                <CopyRow label="Account type" value={account.accountType} />
                <CopyRow label="Our GSTIN" value={account.gstin} />
              </div>
            ) : (
              <Notice tone="error">Bank transfer is no longer set up on this site. Choose another way to pay.</Notice>
            )}
          </div>
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm text-slate-700">2. After paying, enter the UTR from your bank so we can match it.</p>
            {transfer.status === 'rejected' && <Notice tone="error">We could not match the last details: {transfer.reviewNote}. Check them and send again.</Notice>}
            <Field label="UTR / transaction reference" value={utr} required placeholder="HDFCR52026110112345678" onChange={setUtr} />
            <Field label="Date paid" type="date" value={paidOn} required onChange={setPaidOn} />
            <Field label="Paid from (bank)" value={payerBank} placeholder="HDFC Bank, Surat" onChange={setPayerBank} />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Sending...' : 'I have paid'}
              </button>
              <button type="button" onClick={cancel} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
};

export const BillingPage: React.FC<{ isAdmin: boolean; onChanged?: () => void }> = ({ isAdmin, onChanged }) => {
  const summary = useReport<BillingSummary>('/api/billing', 'Could not load your plan.');
  const catalogue = useReport<{ plans: BillingPlan[]; trialDays: number; paymentOptions: PaymentOptions; paymentsEnabled: boolean }>(
    '/api/billing/plans',
    'Could not load the plans.',
  );
  const transferReport = useReport<{ transfer: BankTransfer | null; account: SellerBankAccount | null }>(
    isAdmin ? '/api/billing/bank-transfer' : null,
    'Could not load the bank transfer.',
  );
  const [cycle, setCycle] = useState<BillingCycle>('yearly');
  const [chosen, setChosen] = useState<BillingPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const current = summary.data;
  const options = catalogue.data?.paymentOptions;
  const handledReturn = useRef(false);

  const refresh = () => {
    summary.reload();
    transferReport.reload();
    onChanged?.();
  };

  // Coming back from PayPal: capture the order named in the URL, then tidy the URL.
  useEffect(() => {
    if (handledReturn.current) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get('billing');
    if (result !== 'paypal' && result !== 'paypal-cancelled') return;
    handledReturn.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (result === 'paypal-cancelled') {
      setMessage('PayPal payment cancelled. Nothing was charged.');
      return;
    }
    const orderId = params.get('token');
    if (!orderId) return;
    setBusy('paypal');
    api('/api/billing/paypal/capture', sendJson('POST', { orderId }))
      .then(() => {
        setMessage('Paid by PayPal. Your plan is active.');
        refresh();
      })
      .catch((err) => setError(errorMessage(err, 'Could not confirm the PayPal payment.')))
      .finally(() => setBusy(''));
  }, []);

  const payWithRazorpay = async (plan: BillingPlan, method: Method) => {
    const start = await api<CheckoutStart>('/api/billing/checkout', sendJson('POST', { plan: plan.key, cycle }));
    await loadCheckout();
    const preferred = RAZORPAY_METHOD[method];
    const checkout = new window.Razorpay!({
      key: start.keyId,
      subscription_id: start.subscriptionId,
      name: start.name,
      description: start.description,
      prefill: start.prefill,
      // Show the chosen method first; the others stay available below it.
      config: preferred
        ? { display: { blocks: { chosen: { name: 'Your choice', instruments: [{ method: preferred }] } }, sequence: ['block.chosen'], preferences: { show_default_blocks: true } } }
        : undefined,
      theme: { color: '#0f172a' },
      handler: async (response: RazorpayResponse) => {
        try {
          await api('/api/billing/verify', sendJson('POST', response));
          setMessage(`You are on ${plan.name}, billed ${cycle}. A receipt is on its way from Razorpay.`);
          setChosen(null);
          refresh();
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
  };

  const pay = async (plan: BillingPlan, method: Method) => {
    setBusy(method);
    setError('');
    setMessage('');
    try {
      if (method === 'bank_transfer') {
        await api('/api/billing/bank-transfer', sendJson('POST', { plan: plan.key, cycle }));
        setChosen(null);
        transferReport.reload();
        setBusy('');
      } else if (method === 'paypal') {
        const order = await api<{ approveUrl: string }>('/api/billing/paypal/order', sendJson('POST', { plan: plan.key, cycle }));
        window.location.assign(order.approveUrl);
      } else {
        await payWithRazorpay(plan, method);
      }
    } catch (err) {
      setError(errorMessage(err, err instanceof Error ? err.message : 'Could not start the payment.'));
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

  const manual = current?.paymentMethod === 'bank_transfer' || current?.paymentMethod === 'paypal';
  const transfer = transferReport.data?.transfer;

  return (
    <Page
      title="Plan & billing"
      description="Monthly or yearly plans in Indian rupees. Prices exclude 18% GST, which is added when you pay. Pay by UPI, card, net banking, bank transfer, or, from outside India, PayPal in US dollars."
    >
      {(error || summary.error || catalogue.error) && <Notice tone="error">{error || summary.error || catalogue.error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {busy === 'paypal' && <Notice>Confirming your PayPal payment...</Notice>}

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
                  (manual
                    ? `Paid by ${PROVIDER_LABEL[current.paymentMethod!]} until ${date(current.currentPeriodEnd)}. Pay again before then to continue; an early payment adds a period after this one.`
                    : current.cancelAtPeriodEnd
                      ? `Renewal is off. Works until ${date(current.currentPeriodEnd)}.`
                      : `Billed ${current.cycle} through Razorpay. Renews ${date(current.currentPeriodEnd)}.`)}
                {current.access === 'grace' &&
                  (manual
                    ? `The paid period ended ${date(current.currentPeriodEnd)}. Pay within 3 days to avoid interruption.`
                    : 'The last renewal payment did not go through. Razorpay is retrying; update your payment method from the Razorpay email to avoid interruption.')}
                {current.access === 'lapsed' && 'This company is read-only. Choose a plan below to keep working; nothing has been deleted.'}
              </p>
            </div>
            {isAdmin && current.paymentMethod === 'razorpay' && current.access !== 'lapsed' && !current.cancelAtPeriodEnd && (
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

      {transfer && <BankTransferCard transfer={transfer} account={transferReport.data?.account ?? null} onChanged={refresh} />}

      {catalogue.data && !catalogue.data.paymentsEnabled && (
        <Notice>Online payment is not switched on for this site yet. Plans are shown for reference; ask the site owner to set up payments.</Notice>
      )}
      {!isAdmin && <Notice>Only a company admin can change the plan.</Notice>}

      {chosen && options && (
        <Card title={`How would you like to pay for ${chosen.name}, billed ${cycle}?`}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {METHODS.filter((method) => options[method.option]).map((method) => (
              <button
                key={method.key}
                type="button"
                disabled={busy !== ''}
                onClick={() => pay(chosen, method.key)}
                className="text-left rounded-lg border border-slate-300 bg-white p-3 hover:border-slate-900 disabled:opacity-50"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                  {method.icon}
                  {method.label}
                  <span className="ml-auto text-xs font-normal text-slate-500 tabular-nums">
                    {method.key === 'paypal' ? dollars(chosen.pricesUsd[cycle]) : rupees(chosen.prices[cycle].totalInr)}
                  </span>
                </p>
                <p className="mt-1 text-xs text-slate-600">{busy === method.key ? 'Opening...' : method.detail}</p>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Card numbers, UPI PINs, and bank passwords are entered on Razorpay's or PayPal's secure page and never reach this site.
          </p>
          <button type="button" onClick={() => setChosen(null)} className={`${secondaryButton} mt-3`}>
            Back
          </button>
        </Card>
      )}

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
          const isCurrent =
            current?.paymentMethod === 'razorpay' && current.planKey === plan.key && current.cycle === cycle && current.access !== 'lapsed' && !current.cancelAtPeriodEnd;
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
              </p>
              {options?.paypal && <p className="text-xs text-slate-500">Outside India: {dollars(plan.pricesUsd[cycle])} by PayPal</p>}
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
                  disabled={busy !== '' || isCurrent || !catalogue.data?.paymentsEnabled || transfer?.status === 'submitted'}
                  onClick={() => {
                    setChosen(plan);
                    setError('');
                  }}
                  className={`${plan.key === 'growth' ? primaryButton : secondaryButton} mt-4 justify-center`}
                >
                  {isCurrent ? 'Current plan' : manual && current?.planKey === plan.key && current.cycle === cycle ? 'Pay for the next period' : `Choose ${plan.name}`}
                </button>
              )}
            </section>
          );
        })}
      </div>

      <Card title="Questions">
        <div className="grid gap-3 sm:grid-cols-2 text-sm text-slate-700">
          <p><strong>Is GST charged?</strong> Yes, 18% on the plan price for companies in India, shown before you pay. PayPal payments from outside India are an export of services, with no GST.</p>
          <p><strong>Which methods renew on their own?</strong> UPI AutoPay, cards, and net banking renew through Razorpay. Bank transfer and PayPal pay one period; pay again before it ends.</p>
          <p><strong>Can I change plans?</strong> Yes. The new plan starts as soon as it is paid, and any automatic renewal of the old one stops.</p>
          <p><strong>What if a payment is late?</strong> You keep working for 3 days after the period ends; then the company is read-only until a plan is paid.</p>
        </div>
      </Card>

      {current && current.payments.length > 0 && (
        <Card title="Payments">
          <table className="w-full text-sm">
            <TableHead labels={['Date', 'Plan', 'Amount', 'Paid by', 'Status']} />
            <tbody>
              {current.payments.map((payment) => (
                <tr key={payment.id}>
                  <td className={cell}>{date(payment.paidAt)}</td>
                  <td className={`${cell} capitalize`}>
                    {payment.planKey.replace('_', ' ')} {payment.cycle ? `(${payment.cycle})` : ''}
                  </td>
                  <td className={`${cell} tabular-nums`}>{payment.currency === 'USD' ? dollars(payment.amount) : rupees(payment.amount)}</td>
                  <td className={cell}>
                    {PROVIDER_LABEL[payment.provider] ?? payment.provider}
                    {payment.provider === 'razorpay' && payment.method ? ` · ${payment.method.toUpperCase()}` : ''}
                  </td>
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
