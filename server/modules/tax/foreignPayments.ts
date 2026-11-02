import type { Express } from 'express';
import type { DbPool } from '../../core/db.js';
import { closedMonthMessage } from './closedMonths.js';
import { monthRange } from './exportReports.js';
import { financialYearDates, currentFinancialYear, formReader } from '../../core/formInput.js';
import { asyncHandler, currentUser, isUuid } from '../../core/http.js';
import { csvFile, money, taxManager, taxReader, taxWriter } from './taxShared.js';

export const PAYMENT_NATURES = ['commission', 'freight', 'professional', 'royalty', 'interest', 'other'] as const;
type Nature = (typeof PAYMENT_NATURES)[number];

/** Above this total paid to one payee in a financial year, a taxable remittance needs a CA certificate (Form 15CB). */
export const FORM_15CB_THRESHOLD_INR = 500_000;

type Row = {
  id: string; payee_name: string; payee_country: string; nature: Nature; paid_on: string; currency: string; amount_fc: string;
  rate_inr: string; taxable_in_india: boolean; tds_rate: string; tds_inr: string; dtaa_applied: boolean; trc_received: boolean;
  form_15ca_ack: string; form_15cb_no: string; related_party: boolean; reference: string; notes: string; payee_year_inr: string;
};

export type Form15caPart = 'A' | 'C' | 'D';

/**
 * Which part of Form 15CA usually applies. Part B (a lower-deduction order under section 195(2), 195(3)
 * or 197) is not worked out here; the accountant chooses it when such an order exists.
 */
export function form15caPart(taxable: boolean, payeeYearInr: number): Form15caPart {
  if (!taxable) return 'D';
  return payeeYearInr > FORM_15CB_THRESHOLD_INR ? 'C' : 'A';
}

function toPayment(row: Row) {
  const amountFc = money(row.amount_fc);
  const rateInr = Number(row.rate_inr);
  const amountInr = money(amountFc * rateInr);
  const tdsRate = Number(row.tds_rate);
  const tdsInr = money(row.tds_inr);
  const part = form15caPart(row.taxable_in_india, Number(row.payee_year_inr));
  const issues: Array<{ tone: 'red' | 'amber'; text: string }> = [];
  if (row.taxable_in_india && tdsInr === 0) {
    issues.push({ tone: 'red', text: 'Marked taxable in India but no TDS deducted. The expense can be disallowed (section 40(a)(i)).' });
  }
  if (tdsInr > 0 && tdsRate > 0 && Math.abs(money((amountInr * tdsRate) / 100) - tdsInr) > 10) {
    issues.push({ tone: 'amber', text: `TDS of ₹${tdsInr.toFixed(2)} does not match ${tdsRate}% of ₹${amountInr.toFixed(2)}.` });
  }
  if (row.dtaa_applied && !row.trc_received) {
    issues.push({ tone: 'red', text: 'Treaty (DTAA) rate used without a Tax Residency Certificate from the payee.' });
  }
  if (!row.form_15ca_ack) issues.push({ tone: 'amber', text: `Form 15CA (Part ${part}) acknowledgement not recorded.` });
  if (part === 'C' && !row.form_15cb_no) issues.push({ tone: 'red', text: 'Over ₹5 lakh to this payee this year: Form 15CB from a CA is needed.' });
  return {
    id: row.id,
    payeeName: row.payee_name,
    payeeCountry: row.payee_country,
    nature: row.nature,
    paidOn: row.paid_on,
    currency: row.currency,
    amountFc,
    rateInr,
    amountInr,
    taxableInIndia: row.taxable_in_india,
    tdsRate,
    tdsInr,
    dtaaApplied: row.dtaa_applied,
    trcReceived: row.trc_received,
    form15caAck: row.form_15ca_ack,
    form15cbNo: row.form_15cb_no,
    relatedParty: row.related_party,
    reference: row.reference,
    notes: row.notes,
    payeeYearInr: money(row.payee_year_inr),
    form15caPart: part,
    issues,
  };
}

export type ForeignPayment = ReturnType<typeof toPayment>;

/** Payments in a date range, each with the payee's running total for its own financial year. */
export async function foreignPaymentsBetween(pool: DbPool, organizationId: string, start: string, end: string): Promise<ForeignPayment[]> {
  const result = await pool.query<Row>(
    `SELECT p.id, p.payee_name, p.payee_country, p.nature, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.currency, p.amount_fc,
            p.rate_inr, p.taxable_in_india, p.tds_rate, p.tds_inr, p.dtaa_applied, p.trc_received, p.form_15ca_ack, p.form_15cb_no,
            p.related_party, p.reference, p.notes,
            (SELECT COALESCE(SUM(o.amount_fc * o.rate_inr), 0) FROM foreign_payments o
              WHERE o.organization_id = p.organization_id AND LOWER(TRIM(o.payee_name)) = LOWER(TRIM(p.payee_name))
                AND o.paid_on >= make_date(CASE WHEN EXTRACT(MONTH FROM p.paid_on) >= 4 THEN EXTRACT(YEAR FROM p.paid_on)::int
                                                ELSE EXTRACT(YEAR FROM p.paid_on)::int - 1 END, 4, 1)
                AND o.paid_on <= p.paid_on) AS payee_year_inr
     FROM foreign_payments p
     WHERE p.organization_id = $1 AND p.paid_on BETWEEN $2 AND $3
     ORDER BY p.paid_on, p.payee_name`,
    [organizationId, start, end],
  );
  return result.rows.map(toPayment);
}

export function foreignPaymentTotals(payments: ForeignPayment[]) {
  return {
    count: payments.length,
    amountInr: money(payments.reduce((sum, payment) => sum + payment.amountInr, 0)),
    tdsInr: money(payments.reduce((sum, payment) => sum + payment.tdsInr, 0)),
    withoutTds: payments.filter((payment) => payment.taxableInIndia && payment.tdsInr === 0).length,
    withoutTdsInr: money(payments.filter((payment) => payment.taxableInIndia && payment.tdsInr === 0).reduce((sum, payment) => sum + payment.amountInr, 0)),
    missing15ca: payments.filter((payment) => !payment.form15caAck).length,
    missing15cb: payments.filter((payment) => payment.form15caPart === 'C' && !payment.form15cbNo).length,
    relatedParty: payments.filter((payment) => payment.relatedParty).length,
    issues: payments.filter((payment) => payment.issues.length).length,
  };
}

function readPayment(body: unknown) {
  const form = formReader(body);
  const amountFc = form.number('amountFc', 'Enter the amount paid in the foreign currency.', { min: 0.01 }) as number;
  const rateInr = form.number('rateInr', 'Enter the exchange rate used (rupees per unit).', { min: 0.0001, places: 4 }) as number;
  const tdsRate = form.number('tdsRate', 'TDS rate must be between 0 and 100.', { min: 0, max: 100, optional: true, places: 3 }) ?? 0;
  let tdsInr = form.number('tdsInr', 'TDS amount must be zero or more.', { min: 0, optional: true });
  if (tdsInr === null) tdsInr = money((amountFc * rateInr * tdsRate) / 100);
  return {
    payeeName: form.required('payeeName', 'Enter who was paid.', 200),
    payeeCountry: form.text('payeeCountry', 100),
    nature: form.choice<Nature>('nature', PAYMENT_NATURES, 'other'),
    paidOn: form.date('paidOn', 'Enter the payment date as YYYY-MM-DD.') as string,
    currency: (form.text('currency', 3) || 'USD').toUpperCase(),
    amountFc,
    rateInr,
    taxableInIndia: form.raw.taxableInIndia === undefined ? true : form.flag('taxableInIndia'),
    tdsRate,
    tdsInr,
    dtaaApplied: form.flag('dtaaApplied'),
    trcReceived: form.flag('trcReceived'),
    form15caAck: form.text('form15caAck', 50),
    form15cbNo: form.text('form15cbNo', 50),
    relatedParty: form.flag('relatedParty'),
    reference: form.text('reference', 100),
    notes: form.text('notes', 500),
  };
}

export function registerForeignPaymentRoutes(app: Express, pool: DbPool): void {
  app.get('/api/foreign-payments', taxReader, asyncHandler(async (req, res) => {
    const yearToken = typeof req.query.year === 'string' ? req.query.year : '';
    const year = financialYearDates(yearToken) ?? financialYearDates(currentFinancialYear());
    const range = req.query.from || req.query.to ? monthRange(req) : null;
    const start = range?.start ?? year!.start;
    const end = range?.end ?? year!.end;
    const payments = await foreignPaymentsBetween(pool, currentUser(res).organizationId, start, end);
    return res.json({ start, end, payments, totals: foreignPaymentTotals(payments), threshold15cbInr: FORM_15CB_THRESHOLD_INR });
  }));

  app.get('/api/foreign-payments/csv', taxReader, asyncHandler(async (req, res) => {
    const year = financialYearDates(String(req.query.year ?? '')) ?? financialYearDates(currentFinancialYear())!;
    const payments = await foreignPaymentsBetween(pool, currentUser(res).organizationId, year.start, year.end);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="foreign-payments-${year.label}.csv"`);
    return res.send(
      csvFile(
        ['Paid on', 'Payee', 'Country', 'Nature', 'Currency', 'Amount', 'Rate', 'Amount INR', 'Taxable in India', 'TDS %', 'TDS INR',
          'DTAA', 'TRC', 'Form 15CA part', '15CA ack', '15CB no', 'Related party', 'Reference', 'Issues'],
        payments.map((payment) => [
          payment.paidOn, payment.payeeName, payment.payeeCountry, payment.nature, payment.currency, payment.amountFc.toFixed(2),
          payment.rateInr, payment.amountInr.toFixed(2), payment.taxableInIndia ? 'Yes' : 'No', payment.tdsRate, payment.tdsInr.toFixed(2),
          payment.dtaaApplied ? 'Yes' : 'No', payment.trcReceived ? 'Yes' : 'No', payment.form15caPart, payment.form15caAck,
          payment.form15cbNo, payment.relatedParty ? 'Yes' : 'No', payment.reference, payment.issues.map((issue) => issue.text).join('; '),
        ]),
      ),
    );
  }));

  app.post('/api/foreign-payments', taxWriter, asyncHandler(async (req, res) => {
    const input = readPayment(req.body);
    const user = currentUser(res);
    const closed = await closedMonthMessage(pool, user.organizationId, input.paidOn);
    if (closed) return res.status(409).json({ error: closed.replace('this invoice', 'this payment') });
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO foreign_payments (organization_id, payee_name, payee_country, nature, paid_on, currency, amount_fc, rate_inr,
         taxable_in_india, tds_rate, tds_inr, dtaa_applied, trc_received, form_15ca_ack, form_15cb_no, related_party, reference, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
      [user.organizationId, input.payeeName, input.payeeCountry, input.nature, input.paidOn, input.currency, input.amountFc, input.rateInr,
        input.taxableInIndia, input.tdsRate, input.tdsInr, input.dtaaApplied, input.trcReceived, input.form15caAck, input.form15cbNo,
        input.relatedParty, input.reference, input.notes, user.id],
    );
    return res.status(201).json({ id: inserted.rows[0].id });
  }));

  app.put('/api/foreign-payments/:id', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Payment not found.' });
    const input = readPayment(req.body);
    const user = currentUser(res);
    const existing = await pool.query<{ paid_on: string }>(
      `SELECT to_char(paid_on, 'YYYY-MM-DD') AS paid_on FROM foreign_payments WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Payment not found.' });
    const closed = (await closedMonthMessage(pool, user.organizationId, existing.rows[0].paid_on))
      ?? (await closedMonthMessage(pool, user.organizationId, input.paidOn));
    if (closed) return res.status(409).json({ error: closed.replace('this invoice', 'this payment') });
    await pool.query(
      `UPDATE foreign_payments SET payee_name = $3, payee_country = $4, nature = $5, paid_on = $6, currency = $7, amount_fc = $8,
         rate_inr = $9, taxable_in_india = $10, tds_rate = $11, tds_inr = $12, dtaa_applied = $13, trc_received = $14,
         form_15ca_ack = $15, form_15cb_no = $16, related_party = $17, reference = $18, notes = $19
       WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId, input.payeeName, input.payeeCountry, input.nature, input.paidOn, input.currency,
        input.amountFc, input.rateInr, input.taxableInIndia, input.tdsRate, input.tdsInr, input.dtaaApplied, input.trcReceived,
        input.form15caAck, input.form15cbNo, input.relatedParty, input.reference, input.notes],
    );
    return res.json({ id: req.params.id });
  }));

  app.delete('/api/foreign-payments/:id', taxManager, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Payment not found.' });
    const user = currentUser(res);
    const existing = await pool.query<{ paid_on: string }>(
      `SELECT to_char(paid_on, 'YYYY-MM-DD') AS paid_on FROM foreign_payments WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Payment not found.' });
    const closed = await closedMonthMessage(pool, user.organizationId, existing.rows[0].paid_on);
    if (closed) return res.status(409).json({ error: closed.replace('this invoice', 'this payment') });
    await pool.query('DELETE FROM foreign_payments WHERE id = $1 AND organization_id = $2', [req.params.id, user.organizationId]);
    return res.json({ deleted: true });
  }));
}
