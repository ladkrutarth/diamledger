import type { Express } from 'express';
import type { DbPool } from './db.js';
import { parseMonth } from './closedMonths.js';
import { asyncHandler, currentUser } from './http.js';
import { csvFile, currentMonth, money, sendDownload, taxReader } from './taxShared.js';

export const FOREX_LEDGER = 'Foreign Exchange Gain / Loss';

type ForexSource = {
  payment_id: string;
  invoice_id: string;
  invoice_number: string;
  buyer_name: string;
  paid_on: string;
  amount_usd: string;
  reference: string;
  bank_rate_inr: string | null;
  invoice_rate_inr: string | null;
  bank_name: string | null;
  company_name: string | null;
};

export async function forexRows(pool: DbPool, organizationId: string, month: string) {
  const result = await pool.query<ForexSource>(
    `SELECT p.id AS payment_id, i.id AS invoice_id, i.invoice_number, i.buyer_name,
            to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount_usd, p.reference, p.bank_rate_inr,
            i.data->>'exchangeRateInr' AS invoice_rate_inr,
            i.data->'bank'->>'bankName' AS bank_name,
            i.data->'exporter'->>'companyName' AS company_name
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE p.organization_id = $1 AND to_char(p.paid_on, 'YYYY-MM') = $2
     ORDER BY p.paid_on, i.invoice_number`,
    [organizationId, month],
  );
  return result.rows.map((row) => {
    const amountUsd = money(row.amount_usd);
    const invoiceRate = Number(row.invoice_rate_inr) > 0 ? Number(row.invoice_rate_inr) : null;
    const bankRate = row.bank_rate_inr === null ? null : Number(row.bank_rate_inr);
    const invoiceInr = invoiceRate === null ? null : money(amountUsd * invoiceRate);
    const bankInr = bankRate === null ? null : money(amountUsd * bankRate);
    return {
      paymentId: row.payment_id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      buyerName: row.buyer_name,
      paidOn: row.paid_on,
      amountUsd,
      reference: row.reference,
      invoiceRateInr: invoiceRate,
      bankRateInr: bankRate,
      invoiceInr,
      bankInr,
      gainInr: invoiceInr === null || bankInr === null ? null : money(bankInr - invoiceInr),
      bankLedger: row.bank_name?.trim() || 'Bank',
      companyName: row.company_name?.trim() || '',
    };
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function ledgerEntry(ledger: string, amount: number): string {
  const debit = amount > 0;
  return `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>${(-amount).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
}

/** Receipt vouchers: debit bank at the bank rate, credit the buyer at the invoice rate, and post the difference. */
export function forexTallyXml(rows: Awaited<ReturnType<typeof forexRows>>): string {
  const vouchers = rows
    .filter((row) => row.bankInr !== null && row.invoiceInr !== null && row.gainInr !== null)
    .map((row) => {
      const gain = row.gainInr as number;
      const entries = [
        ledgerEntry(row.bankLedger, row.bankInr as number),
        ledgerEntry(row.buyerName, -(row.invoiceInr as number)),
      ];
      if (gain !== 0) entries.push(ledgerEntry(FOREX_LEDGER, -gain));
      return `          <VOUCHER VCHTYPE="Receipt" ACTION="Create">
            <DATE>${row.paidOn.replace(/-/g, '')}</DATE>
            <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
            <REFERENCE>${escapeXml(row.invoiceNumber)}</REFERENCE>
            <NARRATION>${escapeXml(`Export realization against ${row.invoiceNumber}: USD ${row.amountUsd.toFixed(2)} at bank rate ${row.bankRateInr} (invoice rate ${row.invoiceRateInr}). Ref ${row.reference || '-'}.`)}</NARRATION>
${entries.join('\n')}
          </VOUCHER>`;
    });
  const company = rows[0]?.companyName ?? '';
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
${vouchers.join('\n')}
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

export function registerForexRoutes(app: Express, pool: DbPool): void {
  app.get('/api/tax/forex', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const rows = await forexRows(pool, currentUser(res).organizationId, month);
    const priced = rows.filter((row) => row.gainInr !== null);
    const gains = priced.reduce((sum, row) => sum + Math.max(0, row.gainInr as number), 0);
    const losses = priced.reduce((sum, row) => sum + Math.min(0, row.gainInr as number), 0);
    return res.json({
      month,
      rows,
      missingRateCount: rows.length - priced.length,
      totals: { gainInr: money(gains), lossInr: money(losses), netInr: money(gains + losses) },
    });
  }));

  app.get('/api/tax/forex/tally', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const rows = await forexRows(pool, currentUser(res).organizationId, month);
    return sendDownload(res, `tally-forex-${month}.xml`, 'application/xml', forexTallyXml(rows));
  }));

  app.get('/api/tax/forex/csv', taxReader, asyncHandler(async (req, res) => {
    const month = parseMonth(req.query.month) ?? currentMonth();
    const rows = await forexRows(pool, currentUser(res).organizationId, month);
    const body = csvFile(
      ['Invoice number', 'Buyer', 'Date received', 'USD', 'Invoice rate', 'Bank rate', 'INR at invoice rate', 'INR at bank rate', 'Gain (loss) INR', 'Bank reference'],
      rows.map((row) => [
        row.invoiceNumber, row.buyerName, row.paidOn, row.amountUsd.toFixed(2), row.invoiceRateInr ?? '', row.bankRateInr ?? '',
        row.invoiceInr?.toFixed(2) ?? '', row.bankInr?.toFixed(2) ?? '', row.gainInr?.toFixed(2) ?? '', row.reference,
      ]),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="forex-${month}.csv"`);
    return res.send(body);
  }));
}
