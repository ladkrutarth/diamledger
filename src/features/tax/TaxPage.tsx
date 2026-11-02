import React, { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { PlanFeature } from '../../api/client';
import { Card, primaryButton } from '../../components/ui';
import { AuditChecksDesk, AuditPackDesk } from './AuditDesks';
import { BankDesk } from './BankDesk';
import { CalendarDesk } from './CalendarDesk';
import { FilingDesk } from './FilingDesk';
import { ForeignPaymentsDesk } from './ForeignPaymentsDesk';
import { ForexDesk } from './ForexDesk';
import { MonthsDesk } from './MonthsDesk';
import { NoticesDesk } from './NoticesDesk';
import { PurchasesDesk } from './PurchasesDesk';
import { RatesDesk } from './RatesDesk';
import { RealizationDesk } from './RealizationDesk';
import { RefundDesk } from './RefundDesk';
import { RegisterDesk } from './RegisterDesk';
import { TallyDesk } from './TallyDesk';

type DeskKey =
  | 'calendar' | 'filing' | 'register' | 'purchases' | 'refund'
  | 'bank' | 'tally' | 'realization' | 'forex' | 'rates'
  | 'foreign' | 'checks' | 'auditpack'
  | 'notices' | 'months';

type Desk = { key: DeskKey; label: string; description: string; feature?: PlanFeature };

/**
 * The tax desk, grouped the way an accounts team works: what is due, GST, bank and foreign exchange,
 * income tax and audit, and correspondence and sign-off. Each desk is one job.
 */
const GROUPS: Array<{ label: string; desks: Desk[] }> = [
  {
    label: 'Overview',
    desks: [{ key: 'calendar', label: 'Due dates', description: 'GSTR-1, GSTR-3B, LUT renewal, realization, and refund deadlines, with what is overdue.' }],
  },
  {
    label: 'GST',
    desks: [
      { key: 'filing', label: 'GSTR-1 filing check', description: 'Table 6A and e-invoice readiness for every issued invoice in the month.' },
      { key: 'register', label: 'Export register', description: 'Issued invoices with scheme, shipping bill, and review, and the GST pack download.' },
      { key: 'purchases', label: 'Purchases & ITC', description: 'Purchase register and the GSTR-2B match: credit matched, at risk, and not claimed.', feature: 'advanced_tax' },
      { key: 'refund', label: 'GST refund', description: 'Refund statement for zero-rated exports under LUT, with what is missing for each invoice.' },
    ],
  },
  {
    label: 'Bank & forex',
    desks: [
      { key: 'bank', label: 'Bank match', description: 'Import a statement and match each credit to an invoice.' },
      { key: 'tally', label: 'Tally match', description: 'Compare sales, receipts, and purchases in Tally with the app.', feature: 'advanced_tax' },
      { key: 'realization', label: 'FEMA realization', description: 'Deadline for each export and e-BRC import.' },
      { key: 'forex', label: 'Exchange gain / loss', description: 'Invoice rate against bank rate for each receipt, ready for Tally.' },
      { key: 'rates', label: 'Exchange rates', description: 'Daily reference rates and your own rates.' },
    ],
  },
  {
    label: 'Income tax & audit',
    desks: [
      { key: 'foreign', label: 'Payments abroad / TDS', description: 'TDS, treaty rate, and Form 15CA / 15CB for payments outside India.', feature: 'advanced_tax' },
      { key: 'checks', label: 'Audit checks', description: 'Numbering gaps, edits after reopening, unusual rates, and other findings to explain.', feature: 'audit' },
      { key: 'auditpack', label: 'Tax audit (3CD)', description: 'Form 3CD figures from the books, with one zip download for the auditor.', feature: 'audit' },
    ],
  },
  {
    label: 'Notices & sign-off',
    desks: [
      { key: 'notices', label: 'Notices', description: 'GST, Income Tax, Customs, DGFT, and RBI notices with reply dates and drafted replies.', feature: 'advanced_tax' },
      { key: 'months', label: 'Closed months', description: 'Months the CA has signed off, and the financial year pack.' },
    ],
  },
];

const ALL_DESKS = GROUPS.flatMap((group) => group.desks.map((desk) => ({ ...desk, group: group.label })));
const PLAN_FOR: Record<string, string> = { advanced_tax: 'Growth', audit: 'Business' };
const STORAGE_KEY = 'tax-desk';

interface Props {
  isCharteredAccountant: boolean;
  canWrite: boolean;
  canManage: boolean;
  /** Features on the company's plan; desks outside it show what unlocks them. Undefined means unknown, so all are shown open. */
  planFeatures?: PlanFeature[];
  onUpgrade?: () => void;
  onOpen: (id: string) => void;
}

export const TaxPage: React.FC<Props> = ({ isCharteredAccountant, canWrite, canManage, planFeatures, onUpgrade, onOpen }) => {
  const [deskKey, setDeskKey] = useState<DeskKey>(() => {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    return ALL_DESKS.some((desk) => desk.key === saved) ? (saved as DeskKey) : 'calendar';
  });
  useEffect(() => window.sessionStorage.setItem(STORAGE_KEY, deskKey), [deskKey]);

  const desk = ALL_DESKS.find((entry) => entry.key === deskKey) ?? ALL_DESKS[0];
  const lockedDesk = (entry: Desk) => Boolean(entry.feature && planFeatures && !planFeatures.includes(entry.feature));
  const locked = lockedDesk(desk);

  return (
    <div className="flex-1 overflow-hidden bg-slate-100 flex flex-col md:flex-row">
      {/* Desk menu: a side list on wide screens, a grouped picker on small ones */}
      <nav aria-label="Tax desk" className="hidden md:block w-60 shrink-0 overflow-y-auto border-r border-stone-200 bg-white px-3 py-5">
        <p className="px-2 text-sm font-semibold text-slate-950">Tax desk</p>
        {GROUPS.map((group) => (
          <div key={group.label} className="mt-4">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</p>
            <ul className="mt-1 space-y-0.5">
              {group.desks.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => setDeskKey(entry.key)}
                    aria-current={entry.key === deskKey ? 'page' : undefined}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      entry.key === deskKey ? 'bg-slate-900 font-medium text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {entry.label}
                    {lockedDesk(entry) && <Lock className={`h-3 w-3 shrink-0 ${entry.key === deskKey ? 'text-slate-300' : 'text-slate-400'}`} aria-label="Not on your plan" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="md:hidden border-b border-stone-200 bg-white px-4 py-2">
        <label className="text-[11px] font-semibold text-slate-600">
          Tax desk
          <select value={deskKey} onChange={(event) => setDeskKey(event.target.value as DeskKey)} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
            {GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.desks.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                    {lockedDesk(entry) ? ' (upgrade)' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 px-6 py-7">
          <header className="border-b border-stone-200 pb-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{desk.group}</p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950">{desk.label}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-600">{desk.description}</p>
          </header>

          {locked ? (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Lock className="mt-0.5 h-5 w-5 text-slate-500" />
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{desk.label} is on the {PLAN_FOR[desk.feature!] ?? 'a higher'} plan</p>
                    <p className="text-sm text-slate-600">Your data is already here; upgrading opens this desk straight away.</p>
                  </div>
                </div>
                {onUpgrade && (
                  <button type="button" onClick={onUpgrade} className={primaryButton}>
                    See plans
                  </button>
                )}
              </div>
            </Card>
          ) : (
            <>
              {deskKey === 'calendar' && <CalendarDesk />}
              {deskKey === 'filing' && <FilingDesk onOpen={onOpen} />}
              {deskKey === 'register' && <RegisterDesk onOpen={onOpen} />}
              {deskKey === 'purchases' && <PurchasesDesk canWrite={canWrite} canManage={canManage} />}
              {deskKey === 'refund' && <RefundDesk onOpen={onOpen} />}
              {deskKey === 'bank' && <BankDesk canWrite={canWrite} onOpen={onOpen} />}
              {deskKey === 'tally' && <TallyDesk canWrite={canWrite} onOpen={onOpen} />}
              {deskKey === 'realization' && <RealizationDesk canManage={canManage} onOpen={onOpen} />}
              {deskKey === 'forex' && <ForexDesk canWrite={canWrite} onOpen={onOpen} />}
              {deskKey === 'rates' && <RatesDesk canManage={canManage} />}
              {deskKey === 'foreign' && <ForeignPaymentsDesk canWrite={canWrite} canManage={canManage} />}
              {deskKey === 'checks' && <AuditChecksDesk onOpen={onOpen} />}
              {deskKey === 'auditpack' && <AuditPackDesk />}
              {deskKey === 'notices' && <NoticesDesk canDelete={canManage} />}
              {deskKey === 'months' && <MonthsDesk isCharteredAccountant={isCharteredAccountant} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
};
