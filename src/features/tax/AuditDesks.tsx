import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { type AuditChecksReport, type AuditFinding, type AuditPackReport } from '../../api/client';
import { formatUsd } from '../../utils/invoiceDefaults';
import { Card, Notice, secondaryButton } from '../../components/ui';
import { financialYearStart, MonthRange } from './RefundDesk';
import { Badge, InvoiceLink, Stat, TableHead, YearField, cell, financialYearOf, formatInr, thisMonth, useReport } from '../../components/shared';

const SEVERITY: Record<AuditFinding['severity'], { tone: 'red' | 'amber' | 'slate'; label: string }> = {
  high: { tone: 'red', label: 'High' },
  medium: { tone: 'amber', label: 'Medium' },
  low: { tone: 'slate', label: 'Low' },
};

export const AuditChecksDesk: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
  const [from, setFrom] = useState(financialYearStart());
  const [to, setTo] = useState(thisMonth());
  const [check, setCheck] = useState('');
  const { data, error } = useReport<AuditChecksReport>(`/api/tax/audit-checks?from=${from}&to=${to}`, 'Could not run the audit checks.');
  const findings = data?.findings.filter((finding) => !check || finding.check === check) ?? [];

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <MonthRange from={from} to={to} onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
          <a href={`/api/tax/audit-checks/csv?from=${from}&to=${to}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            CSV for the auditor
          </a>
        </div>
        {data && (
          <div className="mt-4 grid gap-3 grid-cols-3">
            <Stat label="High" value={data.summary.high} tone={data.summary.high ? 'red' : undefined} />
            <Stat label="Medium" value={data.summary.medium} tone={data.summary.medium ? 'amber' : undefined} />
            <Stat label="Low" value={data.summary.low} />
          </div>
        )}
        {data && Object.keys(data.summary.byCheck).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            <button type="button" onClick={() => setCheck('')} className={`px-2 py-1 text-xs rounded-lg border ${check ? 'bg-white border-slate-300' : 'bg-slate-900 text-white border-slate-900'}`}>
              All
            </button>
            {Object.entries(data.summary.byCheck).map(([key, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCheck(key)}
                className={`px-2 py-1 text-xs rounded-lg border ${check === key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300'}`}
              >
                {data.labels[key] ?? key} ({count})
              </button>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Checks an auditor would otherwise sample by hand: gaps in invoice numbers, changes made after a month was reopened, rates far from
          similar stones, payments with no bank credit, round figures, Sunday invoices, missing shipping bills, and payments abroad without
          TDS or Form 15CA. A finding is a prompt to keep an explanation on file, not a mistake by itself.
        </p>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Running checks...</p>
        ) : findings.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing found between {from} and {to}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Severity', 'Check', 'Invoice', 'Detail']} />
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.id}>
                    <td className={cell}>
                      <Badge tone={SEVERITY[finding.severity].tone}>{SEVERITY[finding.severity].label}</Badge>
                    </td>
                    <td className={`${cell} font-semibold`}>{finding.title}</td>
                    <td className={cell}>
                      {finding.invoiceId && finding.invoiceNumber ? (
                        <InvoiceLink id={finding.invoiceId} number={finding.invoiceNumber} onOpen={onOpen} />
                      ) : (
                        finding.invoiceNumber ?? '—'
                      )}
                    </td>
                    <td className={`${cell} text-slate-700`}>{finding.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};

export const AuditPackDesk: React.FC = () => {
  const [year, setYear] = useState(financialYearOf());
  const { data, error } = useReport<AuditPackReport>(`/api/tax/audit-pack?year=${year}`, 'Could not build the tax audit pack.');
  const ct = (value: number) => `${value.toFixed(3)} ct`;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-40">
            <YearField value={year} onChange={setYear} />
          </div>
          <a href={`/api/tax/audit-pack/zip?year=${year}`} className={secondaryButton}>
            <Download className="w-3.5 h-3.5" />
            Tax audit pack {year}
          </a>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          The figures a tax auditor collects for Form 3CD, taken from the books in this app: turnover, quantitative details of stock
          (clause 35), purchases by supplier type (clause 44), payments abroad and TDS (clause 34), related parties (clause 23), exchange
          differences, and receivables past the FEMA realization period. The download holds a summary and the registers behind it. The
          auditor still verifies and reports; this saves collecting the numbers.
        </p>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <Card>
          <p className="text-sm text-slate-500">Building the pack...</p>
        </Card>
      ) : (
        <>
          <Card title="Turnover">
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <Stat label={`Under LUT (${data.turnover.lut.invoices})`} value={formatInr(data.turnover.lut.valueInr)} />
              <Stat label={`IGST paid (${data.turnover.igst.invoices})`} value={formatInr(data.turnover.igst.valueInr)} />
              <Stat label="Total USD" value={formatUsd(data.turnover.totalUsd)} />
              <Stat label="Invoices without a rate" value={data.turnover.missingRate} tone={data.turnover.missingRate ? 'amber' : undefined} />
            </div>
          </Card>
          <Card title="Clause 35: quantitative details">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead labels={['', 'Opening', 'Purchased', 'Produced', 'Used in manufacture', 'Sold', 'Closing', 'Closing value']} />
                <tbody>
                  {(['rough', 'polished'] as const).map((kind) => (
                    <tr key={kind}>
                      <td className={`${cell} font-semibold capitalize`}>{kind}</td>
                      <td className={`${cell} tabular-nums`}>{ct(data.stock[kind].opening)}</td>
                      <td className={`${cell} tabular-nums`}>{ct(data.stock[kind].purchased)}</td>
                      <td className={`${cell} tabular-nums`}>{ct(data.stock[kind].produced)}</td>
                      <td className={`${cell} tabular-nums`}>{ct(data.stock[kind].consumed)}</td>
                      <td className={`${cell} tabular-nums`}>{ct(data.stock[kind].sold)}</td>
                      <td className={`${cell} tabular-nums font-semibold`}>{ct(data.stock[kind].closing)}</td>
                      <td className={`${cell} tabular-nums`}>
                        {formatInr(data.stock[kind].closingValueInr)}
                        {data.stock[kind].parcelsWithoutCost > 0 && <p className="text-xs text-amber-800">{data.stock[kind].parcelsWithoutCost} parcels without cost</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Yield {data.stock.yieldPercent === null ? 'not recorded' : `${data.stock.yieldPercent}%`} · process loss {ct(data.stock.processLossCarats)}
              {data.stock.negativeParcels.length > 0 && <span className="text-red-700"> · negative stock in {data.stock.negativeParcels.join(', ')}</span>}
            </p>
          </Card>
          <Card title="TDS, exchange differences, receivables">
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
              <Stat label="Paid abroad" value={formatInr(data.tds.amountInr)} />
              <Stat label="Taxable, no TDS" value={formatInr(data.tds.withoutTdsInr)} tone={data.tds.withoutTds ? 'red' : undefined} />
              <Stat label="Net exchange gain (loss)" value={formatInr(data.forex.netInr)} />
              <Stat label="Past realization period" value={formatUsd(data.receivables.pastRealizationUsd)} tone={data.receivables.pastRealizationUsd ? 'red' : undefined} />
            </div>
          </Card>
          <Card title="Summary for Form 3CD">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead labels={['Area / clause', 'Item', 'Count or quantity', 'USD', 'INR']} />
                <tbody>
                  {data.summary.map((row, index) => (
                    <tr key={index}>
                      {row.map((value, column) => (
                        <td key={column} className={`${cell} ${column >= 3 ? 'tabular-nums' : ''} ${column === 0 ? 'whitespace-nowrap text-slate-500' : ''}`}>
                          {value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
};
