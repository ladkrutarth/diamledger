import crypto from 'node:crypto';
import type { Express } from 'express';
import type { DbPool } from './db.js';
import { asyncHandler, currentUser, isUuid } from './http.js';
import { parseBankRate, recordPayment } from './payments.js';
import { findColumn, money, parseAmount, parseCsv, parseLooseDate, taxReader, taxWriter } from './taxShared.js';

const MAX_IMPORT_ROWS = 2000;
const NAME_NOISE = new Set([
  'LTD', 'LIMITED', 'INC', 'LLC', 'CO', 'COMPANY', 'CORP', 'BVBA', 'DMCC', 'FZE', 'FZCO', 'GMBH', 'SONS',
  'TRADING', 'DIAMONDS', 'DIAMOND', 'GEMS', 'JEWELS', 'JEWELRY', 'JEWELLERY', 'INTERNATIONAL', 'THE', 'AND',
]);

type OpenInvoice = { id: string; invoice_number: string; buyer_name: string; total_usd: string; paid_usd: string };

export type MatchSuggestion = {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  dueUsd: number;
  score: number;
  reasons: string[];
  shortByUsd: number;
};

function squash(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function suggestMatches(
  line: { amountUsd: number; reference: string; narration: string },
  invoices: Array<{ id: string; invoiceNumber: string; buyerName: string; dueUsd: number }>,
): MatchSuggestion[] {
  const text = `${line.reference} ${line.narration}`.toUpperCase();
  const squashed = squash(text);
  const words = new Set(text.split(/[^A-Z0-9]+/).filter(Boolean));
  const suggestions: MatchSuggestion[] = [];
  for (const invoice of invoices) {
    if (invoice.dueUsd <= 0) continue;
    let score = 0;
    const reasons: string[] = [];
    const number = squash(invoice.invoiceNumber);
    const tail = invoice.invoiceNumber.split(/[/-]/).pop() ?? '';
    if (number.length >= 4 && squashed.includes(number)) {
      score += 60;
      reasons.push('Invoice number is in the narration');
    } else if (tail.length >= 4 && words.has(tail.toUpperCase())) {
      score += 25;
      reasons.push(`Invoice serial ${tail} is in the narration`);
    }
    const nameTokens = invoice.buyerName
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((token) => token.length >= 4 && !NAME_NOISE.has(token));
    if (nameTokens.length && nameTokens.some((token) => words.has(token))) {
      score += 25;
      reasons.push('Buyer name matches the remitter');
    }
    const shortBy = money(invoice.dueUsd - line.amountUsd);
    if (Math.abs(shortBy) <= 0.01) {
      score += 30;
      reasons.push('Amount equals the balance due');
    } else if (shortBy > 0 && shortBy <= Math.max(75, invoice.dueUsd * 0.005)) {
      score += 20;
      reasons.push(`Short by $${shortBy.toFixed(2)}, probably bank charges`);
    } else if (shortBy > 0) {
      score += 5;
      reasons.push('Part payment');
    } else {
      continue;
    }
    if (score >= 25) {
      suggestions.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        buyerName: invoice.buyerName,
        dueUsd: invoice.dueUsd,
        score: Math.min(100, score),
        reasons,
        shortByUsd: Math.max(0, shortBy),
      });
    }
  }
  return suggestions.sort((a, b) => b.score - a.score).slice(0, 3);
}

async function openInvoices(pool: DbPool, organizationId: string) {
  const result = await pool.query<OpenInvoice>(
    `SELECT i.id, i.invoice_number, i.buyer_name, i.total_usd,
            COALESCE((SELECT SUM(amount_usd) FROM payments WHERE invoice_id = i.id), 0) AS paid_usd
     FROM invoices i
     WHERE i.organization_id = $1 AND i.status = 'issued'`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    buyerName: row.buyer_name,
    dueUsd: money(Number(row.total_usd) - Number(row.paid_usd)),
  }));
}

type BankLineRow = {
  id: string;
  line_date: string;
  amount_usd: string;
  bank_rate_inr: string | null;
  reference: string;
  narration: string;
  status: 'unmatched' | 'matched' | 'ignored';
  invoice_id: string | null;
  invoice_number: string | null;
};

export function registerBankRoutes(app: Express, pool: DbPool): void {
  app.post('/api/bank/import', taxWriter, asyncHandler(async (req, res) => {
    const text = typeof req.body?.csv === 'string' ? req.body.csv : '';
    const rows = parseCsv(text);
    if (rows.length < 2) return res.status(400).json({ error: 'Upload a CSV with a header row and at least one transaction.' });
    if (rows.length > MAX_IMPORT_ROWS + 1) return res.status(400).json({ error: `Import at most ${MAX_IMPORT_ROWS} lines at a time.` });
    const [header, ...lines] = rows;
    const dateColumn = findColumn(header, ['value date', 'date', 'txn date', 'transaction date', 'posting date']);
    const amountColumn = findColumn(header, ['credit', 'credit amount', 'amount', 'amount usd', 'usd', 'deposit']);
    const referenceColumn = findColumn(header, ['reference', 'ref', 'ref no', 'utr', 'swift reference', 'cheque no']);
    const narrationColumn = findColumn(header, ['narration', 'description', 'details', 'remitter', 'particulars', 'remarks']);
    const rateColumn = findColumn(header, ['rate', 'exchange rate', 'inr rate', 'conversion rate']);
    if (dateColumn < 0 || amountColumn < 0) {
      return res.status(400).json({ error: 'The CSV needs a date column and a credit or amount column.' });
    }
    const organizationId = currentUser(res).organizationId;
    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const cells of lines) {
      const lineDate = parseLooseDate(cells[dateColumn]);
      const amount = parseAmount(cells[amountColumn]);
      const rate = rateColumn >= 0 ? parseBankRate(cells[rateColumn]?.trim()) : null;
      if (!lineDate || amount === null || amount <= 0 || rate === undefined) {
        skipped += 1;
        continue;
      }
      const reference = referenceColumn >= 0 ? (cells[referenceColumn] ?? '').trim().slice(0, 200) : '';
      const narration = narrationColumn >= 0 ? (cells[narrationColumn] ?? '').trim().slice(0, 500) : '';
      const fingerprint = crypto.createHash('sha256').update([lineDate, amount.toFixed(2), reference, narration].join('|')).digest('hex');
      const inserted = await pool.query(
        `INSERT INTO bank_lines (organization_id, line_date, amount_usd, bank_rate_inr, reference, narration, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, fingerprint) DO NOTHING`,
        [organizationId, lineDate, amount, rate, reference, narration, fingerprint],
      );
      if (inserted.rowCount) imported += 1;
      else duplicates += 1;
    }
    return res.status(201).json({ imported, duplicates, skipped });
  }));

  app.get('/api/bank/lines', taxReader, asyncHandler(async (req, res) => {
    const status = req.query.status === 'matched' || req.query.status === 'ignored' ? req.query.status : 'unmatched';
    const organizationId = currentUser(res).organizationId;
    const result = await pool.query<BankLineRow>(
      `SELECT b.id, to_char(b.line_date, 'YYYY-MM-DD') AS line_date, b.amount_usd, b.bank_rate_inr, b.reference, b.narration,
              b.status, b.invoice_id, i.invoice_number
       FROM bank_lines b
       LEFT JOIN invoices i ON i.id = b.invoice_id
       WHERE b.organization_id = $1 AND b.status = $2
       ORDER BY b.line_date DESC, b.created_at DESC
       LIMIT 300`,
      [organizationId, status],
    );
    const invoices = status === 'unmatched' ? await openInvoices(pool, organizationId) : [];
    const counts = await pool.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*) AS count FROM bank_lines WHERE organization_id = $1 GROUP BY status',
      [organizationId],
    );
    return res.json({
      status,
      counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
      lines: result.rows.map((row) => {
        const amountUsd = money(row.amount_usd);
        return {
          id: row.id,
          lineDate: row.line_date,
          amountUsd,
          bankRateInr: row.bank_rate_inr === null ? null : Number(row.bank_rate_inr),
          reference: row.reference,
          narration: row.narration,
          status: row.status,
          invoiceId: row.invoice_id,
          invoiceNumber: row.invoice_number,
          suggestions: status === 'unmatched'
            ? suggestMatches({ amountUsd, reference: row.reference, narration: row.narration }, invoices)
            : [],
        };
      }),
    });
  }));

  app.post('/api/bank/lines/:id/match', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.body?.invoiceId)) return res.status(404).json({ error: 'Bank line not found.' });
    const user = currentUser(res);
    const line = await pool.query<{ line_date: string; amount_usd: string; bank_rate_inr: string | null; reference: string; narration: string; status: string }>(
      `SELECT to_char(line_date, 'YYYY-MM-DD') AS line_date, amount_usd, bank_rate_inr, reference, narration, status
       FROM bank_lines WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    const found = line.rows[0];
    if (!found) return res.status(404).json({ error: 'Bank line not found.' });
    if (found.status !== 'unmatched') return res.status(409).json({ error: 'This bank line is already dealt with.' });
    const bankRate = req.body?.bankRateInr === undefined || req.body?.bankRateInr === '' ? found.bank_rate_inr : req.body.bankRateInr;
    const result = await recordPayment(
      pool,
      user,
      req.body.invoiceId,
      {
        amountUsd: found.amount_usd,
        paidOn: found.line_date,
        reference: found.reference || found.narration.slice(0, 200),
        bankRateInr: bankRate,
      },
      { withinBalance: true },
    );
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    await pool.query(
      `UPDATE bank_lines SET status = 'matched', invoice_id = $3, payment_id = $4 WHERE id = $1 AND organization_id = $2`,
      [req.params.id, user.organizationId, req.body.invoiceId, result.paymentId],
    );
    return res.json({ matched: true, dueUsd: result.state.dueUsd, status: result.state.status });
  }));

  app.post('/api/bank/lines/:id/ignore', taxWriter, asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Bank line not found.' });
    const result = await pool.query(
      `UPDATE bank_lines SET status = 'ignored' WHERE id = $1 AND organization_id = $2 AND status = 'unmatched'`,
      [req.params.id, currentUser(res).organizationId],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Bank line not found.' });
    return res.json({ ignored: true });
  }));
}
