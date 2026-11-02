import React, { useState } from 'react';
import { api, errorMessage, sendJson, type BankTransfer } from '../../api/client';
import { Badge, TableHead, cell, useReport } from '../../components/shared';
import { Card, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';

const STATUS_TONE: Record<BankTransfer['status'], 'green' | 'amber' | 'red' | 'slate'> = {
  awaiting: 'slate',
  submitted: 'amber',
  approved: 'green',
  rejected: 'red',
  cancelled: 'slate',
};

/**
 * For the people who run this site (PLATFORM_ADMIN_EMAILS): bank transfers to check against the bank
 * statement. Approving one switches the company's plan on for the period it paid for.
 */
export const BankTransfersAdmin: React.FC = () => {
  const [show, setShow] = useState<'submitted' | 'all'>('submitted');
  const { data, error, setError, reload } = useReport<{ transfers: BankTransfer[] }>(`/api/platform/bank-transfers?status=${show}`, 'Could not load bank transfers.');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const act = async (transfer: BankTransfer, action: 'approve' | 'reject') => {
    let note = '';
    if (action === 'reject') {
      note = window.prompt(`Why can't ${transfer.utr} be matched? The company sees this.`, 'No credit with this UTR in the account') ?? '';
      if (!note.trim()) return;
    } else if (!window.confirm(`Approve ₹${transfer.amountInr.toLocaleString('en-IN')} from ${transfer.organizationName}, UTR ${transfer.utr}? Check the bank statement first.`)) {
      return;
    }
    setBusy(transfer.id);
    setError('');
    try {
      await api(`/api/platform/bank-transfers/${transfer.id}/${action}`, sendJson('POST', { note }));
      setMessage(action === 'approve' ? `${transfer.organizationName} is now on ${transfer.planName}.` : `Sent back to ${transfer.organizationName}.`);
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not update the transfer.'));
    } finally {
      setBusy('');
    }
  };

  return (
    <Page
      title="Bank transfers"
      description="Plan payments made by NEFT, RTGS, or IMPS. Match each UTR and amount against your bank statement, then approve it to switch the plan on, or reject it with a reason."
    >
      <div className="flex gap-1">
        {(['submitted', 'all'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setShow(key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${show === key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-800'}`}
          >
            {key === 'submitted' ? 'To check' : 'All'}
          </button>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      <Card>
        {!data ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : data.transfers.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing to check.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead labels={['Company', 'Plan', 'Amount', 'UTR / reference', 'Paid', 'Status', '']} />
              <tbody>
                {data.transfers.map((transfer) => (
                  <tr key={transfer.id}>
                    <td className={cell}>
                      <p className="font-semibold">{transfer.organizationName}</p>
                      <p className="text-xs text-slate-500">{transfer.createdByEmail}</p>
                    </td>
                    <td className={cell}>
                      {transfer.planName} ({transfer.cycle})
                    </td>
                    <td className={`${cell} tabular-nums`}>₹{transfer.amountInr.toLocaleString('en-IN')}</td>
                    <td className={cell}>
                      <p className="font-semibold tabular-nums">{transfer.utr || '—'}</p>
                      <p className="text-xs text-slate-500">{transfer.referenceCode}</p>
                    </td>
                    <td className={cell}>
                      {transfer.paidOn ?? '—'}
                      {transfer.payerBank && <p className="text-xs text-slate-500">{transfer.payerBank}</p>}
                    </td>
                    <td className={cell}>
                      <Badge tone={STATUS_TONE[transfer.status]}>{transfer.status}</Badge>
                      {transfer.reviewNote && <p className="text-xs text-slate-500 mt-1">{transfer.reviewNote}</p>}
                    </td>
                    <td className={`${cell} text-right whitespace-nowrap`}>
                      {transfer.status === 'submitted' && (
                        <>
                          <button type="button" disabled={busy !== ''} onClick={() => act(transfer, 'approve')} className={primaryButton}>
                            Approve
                          </button>
                          <button type="button" disabled={busy !== ''} onClick={() => act(transfer, 'reject')} className={`${dangerButton} ml-2`}>
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-500">
        <button type="button" onClick={reload} className={secondaryButton}>
          Refresh
        </button>
      </p>
    </Page>
  );
};
