/** Razorpay Checkout in the browser: the script, and the parts of its API this app uses. Card numbers, UPI PINs
 * and bank passwords are typed into Razorpay's own window and never reach this app. */

export type RazorpayFailure = { error?: { description?: string } };
export type RazorpayInstance = { open: () => void; on: (event: 'payment.failed', handler: (response: RazorpayFailure) => void) => void };

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

/** Loads Razorpay Checkout once. Allowed by the Content Security Policy (core/security.py and vercel.json). */
export function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.'));
    document.body.appendChild(script);
  });
}
