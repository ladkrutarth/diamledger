import { razorpayConfigured } from './razorpay.js';

/**
 * Which ways to pay are switched on, from environment variables. Card numbers, UPI PINs, and bank
 * passwords are never sent to this server: cards, UPI, and net banking are entered on Razorpay's page,
 * and PayPal on PayPal's.
 */

/** The account customers pay into by NEFT, RTGS, or IMPS. On when the account number and IFSC are set. */
export function sellerBankAccount() {
  const env = (key: string) => (process.env[key] ?? '').trim();
  const account = {
    accountName: env('BILLING_BANK_ACCOUNT_NAME'),
    bankName: env('BILLING_BANK_NAME'),
    accountNumber: env('BILLING_BANK_ACCOUNT_NUMBER'),
    ifsc: env('BILLING_BANK_IFSC').toUpperCase(),
    branch: env('BILLING_BANK_BRANCH'),
    accountType: env('BILLING_BANK_ACCOUNT_TYPE') || 'Current',
    gstin: env('BILLING_GSTIN'),
  };
  return account.accountNumber && account.ifsc ? account : null;
}

export function paypalConfigured(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/** Email addresses of the people who run this site and approve bank transfers. */
export function isPlatformAdmin(email: string): boolean {
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

export type PaymentOptions = {
  upi: boolean;
  card: boolean;
  netbanking: boolean;
  bankTransfer: boolean;
  paypal: boolean;
};

export function paymentOptions(): PaymentOptions {
  const razorpay = razorpayConfigured();
  return { upi: razorpay, card: razorpay, netbanking: razorpay, bankTransfer: Boolean(sellerBankAccount()), paypal: paypalConfigured() };
}
