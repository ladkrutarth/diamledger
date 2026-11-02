import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { api, errorMessage, sendJson, type PracticeBill, type PracticeClient, type PracticeOverview, type PracticeTimeEntry } from '../../api/client';
import { Badge, CheckField, SelectField, Stat, TableHead, cell, formatInr, useReport } from '../../components/shared';
import { Card, Field, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

const HEALTH: Record<PracticeClient['health']['grade'], { tone: 'green' | 'amber' | 'red'; label: string }> = {
  good: { tone: 'green', label: 'On track' },
  watch: { tone: 'amber', label: 'Needs attention' },
  at_risk: { tone: 'red', label: 'At risk' },
};

const hours = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
const today = () => new Date().toISOString().slice(0, 10);

type Tab = 'clients' | 'time' | 'bills';

export const PracticePage: React.FC<{ onOpenClient: (id: string) => void }> = ({ onOpenClient }) => {
  const [tab, setTab] = useState<Tab>('clients');
  const overview = useReport<PracticeOverview>('/api/practice/clients', 'Could not load your clients.');
  const time = useReport<{ entries: PracticeTimeEntry[] }>(tab === 'time' ? '/api/practice/time' : null, 'Could not load time entries.');
  const bills = useReport<{ bills: PracticeBill[] }>(tab === 'bills' ? '/api/practice/bills' : null, 'Could not load fee bills.');
  const [timeForm, setTimeForm] = useState({ clientId: '', workDate: today(), hours: '', task: '', billable: true });
  const [billForm, setBillForm] = useState({ clientId: '', billNo: '', billDate: today(), amountInr: '', notes: '' });
  const [error, setError] = useState('');
  const clients = overview.data?.clients ?? [];
  const clientOptions: Array<[string, string]> = [['', 'Choose a client'], ...clients.map((client) => [client.id, client.name] as [string, string])];

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError('');
    try {
      await action();
      overview.reload();
      time.reload();
      bills.reload();
      return true;
    } catch (err) {
      setError(errorMessage(err, fallback));
      return false;
    }
  };

  const setFee = (client: PracticeClient) => {
    const entered = window.prompt(`Fee for ${client.name} in ₹ (per ${client.engagement?.billing ?? 'month'})`, String(client.engagement?.feeInr ?? ''));
    if (entered === null) return;
    run(() => api(`/api/practice/clients/${client.id}/engagement`, sendJson('PUT', { feeInr: entered.replace(/,/g, ''), billing: client.engagement?.billing ?? 'monthly', notes: client.engagement?.notes ?? '' })), 'Could not save the fee.');
  };

  return (
    <Page
      title="Practice"
      description="Every client in one view: what is overdue, open notices and requests, time spent, and fees billed and unpaid."
    >
      <div className="flex gap-1">
        {(
          [
            ['clients', 'Clients'],
            ['time', 'Time'],
            ['bills', 'Fee bills'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {(error || overview.error) && <Notice tone="error">{error || overview.error}</Notice>}

      {overview.data && (
        <Card>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
            <Stat label="Clients" value={overview.data.totals.clients} />
            <Stat label="At risk" value={overview.data.totals.atRisk} tone={overview.data.totals.atRisk ? 'red' : undefined} />
            <Stat label="Time this month" value={hours(overview.data.totals.monthMinutes)} />
            <Stat label={`Billed ${overview.data.year}`} value={formatInr(overview.data.totals.billedYearInr)} />
            <Stat label="Fees unpaid" value={formatInr(overview.data.totals.unpaidInr)} tone={overview.data.totals.unpaidInr ? 'amber' : undefined} />
          </div>
        </Card>
      )}

      {tab === 'clients' && (
        <Card>
          {!overview.data ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <TableHead labels={['Client', 'Health', 'Next up', 'Time (month / year)', 'Fees', '']} />
                <tbody>
                  {clients.map((client) => (
                    <tr key={client.id}>
                      <td className={cell}>
                        <p className="font-semibold">{client.name}</p>
                        <p className="text-xs text-slate-500">
                          {client.engagement ? `${formatInr(client.engagement.feeInr)} ${client.engagement.billing.replace('_', ' ')}` : 'No fee set'}
                        </p>
                      </td>
                      <td className={cell}>
                        <Badge tone={HEALTH[client.health.grade].tone}>
                          {HEALTH[client.health.grade].label} · {client.health.score}
                        </Badge>
                        <p className="mt-1 text-xs text-slate-500">
                          {[
                            client.health.overdue && `${client.health.overdue} overdue`,
                            client.health.dueSoon && `${client.health.dueSoon} due soon`,
                            client.health.openNotices && `${client.health.openNotices} notice${client.health.openNotices === 1 ? '' : 's'}`,
                            client.health.openRequests && `${client.health.openRequests} request${client.health.openRequests === 1 ? '' : 's'}`,
                          ].filter(Boolean).join(' · ') || 'Nothing pending'}
                        </p>
                      </td>
                      <td className={`${cell} text-xs text-slate-700`}>
                        {client.health.nextItems.length === 0
                          ? '—'
                          : client.health.nextItems.map((item) => (
                              <p key={item.title} className={item.status === 'overdue' ? 'text-red-700' : ''}>
                                {item.title}
                                {item.dueDate ? ` (${item.dueDate})` : ''}
                              </p>
                            ))}
                      </td>
                      <td className={`${cell} tabular-nums whitespace-nowrap`}>
                        {hours(client.time.monthMinutes)} / {hours(client.time.yearMinutes)}
                      </td>
                      <td className={`${cell} tabular-nums whitespace-nowrap`}>
                        {formatInr(client.fees.billedYearInr)}
                        {client.fees.unpaidInr > 0 && <p className="text-xs text-amber-800">{formatInr(client.fees.unpaidInr)} unpaid</p>}
                      </td>
                      <td className={`${cell} text-right whitespace-nowrap`}>
                        <button type="button" onClick={() => setFee(client)} className={secondaryButton}>
                          Fee
                        </button>
                        <button type="button" onClick={() => onOpenClient(client.id)} className={`${primaryButton} ml-2`}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'time' && (
        <>
          <Card title="Log time">
            <form
              className="grid grid-cols-1 md:grid-cols-5 gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const minutes = Math.round(Number(timeForm.hours) * 60);
                const ok = await run(
                  () => api('/api/practice/time', sendJson('POST', { clientId: timeForm.clientId, workDate: timeForm.workDate, minutes, task: timeForm.task, billable: timeForm.billable })),
                  'Could not log the time.',
                );
                if (ok) setTimeForm({ ...timeForm, hours: '', task: '' });
              }}
            >
              <SelectField label="Client" value={timeForm.clientId} options={clientOptions} onChange={(value) => setTimeForm({ ...timeForm, clientId: value })} />
              <Field label="Date" type="date" value={timeForm.workDate} onChange={(value) => setTimeForm({ ...timeForm, workDate: value })} />
              <Field label="Hours" value={timeForm.hours} required placeholder="1.5" onChange={(value) => setTimeForm({ ...timeForm, hours: value })} />
              <Field label="Work done" value={timeForm.task} required placeholder="GSTR-1 review" onChange={(value) => setTimeForm({ ...timeForm, task: value })} />
              <CheckField label="Billable" checked={timeForm.billable} onChange={(value) => setTimeForm({ ...timeForm, billable: value })} />
              <div className="md:col-span-5">
                <button type="submit" className={primaryButton}>
                  <Plus className="w-3.5 h-3.5" />
                  Log time
                </button>
              </div>
            </form>
          </Card>
          <Card>
            {!time.data ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : time.data.entries.length === 0 ? (
              <p className="text-sm text-slate-500">No time logged yet.</p>
            ) : (
              <table className="w-full text-sm">
                <TableHead labels={['Date', 'Client', 'Work', 'Time', '']} />
                <tbody>
                  {time.data.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className={`${cell} whitespace-nowrap`}>{entry.workDate}</td>
                      <td className={cell}>{entry.clientName}</td>
                      <td className={cell}>
                        {entry.task}
                        <p className="text-xs text-slate-500">
                          {entry.userEmail}
                          {entry.billable ? '' : ' · not billable'}
                        </p>
                      </td>
                      <td className={`${cell} tabular-nums`}>{hours(entry.minutes)}</td>
                      <td className={`${cell} text-right`}>
                        <button type="button" onClick={() => run(() => api(`/api/practice/time/${entry.id}`, sendJson('DELETE')), 'Could not delete the entry.')} className={dangerButton}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {tab === 'bills' && (
        <>
          <Card title="Record a fee bill">
            <form
              className="grid grid-cols-1 md:grid-cols-5 gap-3"
              onSubmit={async (event) => {
                event.preventDefault();
                const ok = await run(() => api('/api/practice/bills', sendJson('POST', billForm)), 'Could not save the bill.');
                if (ok) setBillForm({ ...billForm, billNo: '', amountInr: '', notes: '' });
              }}
            >
              <SelectField label="Client" value={billForm.clientId} options={clientOptions} onChange={(value) => setBillForm({ ...billForm, clientId: value })} />
              <Field label="Bill no" value={billForm.billNo} required onChange={(value) => setBillForm({ ...billForm, billNo: value })} />
              <Field label="Date" type="date" value={billForm.billDate} onChange={(value) => setBillForm({ ...billForm, billDate: value })} />
              <Field label="Amount (₹)" value={billForm.amountInr} required onChange={(value) => setBillForm({ ...billForm, amountInr: value })} />
              <Field label="Notes" value={billForm.notes} onChange={(value) => setBillForm({ ...billForm, notes: value })} />
              <div className="md:col-span-5">
                <button type="submit" className={primaryButton}>
                  <Plus className="w-3.5 h-3.5" />
                  Save bill
                </button>
              </div>
            </form>
          </Card>
          <Card>
            {!bills.data ? (
              <p className="text-sm text-slate-500">Loading...</p>
            ) : bills.data.bills.length === 0 ? (
              <p className="text-sm text-slate-500">No fee bills yet.</p>
            ) : (
              <table className="w-full text-sm">
                <TableHead labels={['Bill', 'Client', 'Amount', 'Status', '']} />
                <tbody>
                  {bills.data.bills.map((bill) => (
                    <tr key={bill.id}>
                      <td className={cell}>
                        <p className="font-semibold">{bill.billNo}</p>
                        <p className="text-xs text-slate-500">{bill.billDate}</p>
                      </td>
                      <td className={cell}>{bill.clientName}</td>
                      <td className={`${cell} tabular-nums`}>{formatInr(bill.amountInr)}</td>
                      <td className={cell}>
                        {bill.paidOn ? (
                          <Badge tone="green">Paid {bill.paidOn}</Badge>
                        ) : (
                          <Badge tone={(bill.daysUnpaid ?? 0) > 30 ? 'red' : 'amber'}>Unpaid {bill.daysUnpaid} days</Badge>
                        )}
                      </td>
                      <td className={`${cell} text-right whitespace-nowrap`}>
                        <button
                          type="button"
                          onClick={() => run(() => api(`/api/practice/bills/${bill.id}/paid`, sendJson('POST', bill.paidOn ? { paid: false } : {})), 'Could not update the bill.')}
                          className={secondaryButton}
                        >
                          {bill.paidOn ? 'Mark unpaid' : 'Mark paid'}
                        </button>
                        <button type="button" onClick={() => run(() => api(`/api/practice/bills/${bill.id}`, sendJson('DELETE')), 'Could not delete the bill.')} className={`${dangerButton} ml-2`}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </Page>
  );
};
