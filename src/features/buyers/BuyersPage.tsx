import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, errorMessage, sendJson, type Buyer, type BuyerContact, type BuyerRisk } from '../../api/client';
import { BUYER_KEYS, formatUsd } from '../../utils/invoiceDefaults';
import { Badge, TableHead, cell, useReport } from '../../components/shared';
import { Card, Field, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../../components/ui';
import { PortalLinks } from './PortalLinks';

const LABELS: Record<keyof BuyerContact, string> = {
  companyName: 'Company name',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  state: 'State / region',
  country: 'Country',
  postalCode: 'Postal code',
  taxIdVat: 'Tax ID / VAT',
  contactPerson: 'Contact person',
  email: 'Email',
  phone: 'Phone',
};

function blankBuyer(): BuyerContact {
  return Object.fromEntries(BUYER_KEYS.map((key) => [key, ''])) as BuyerContact;
}

const GRADE_TONE: Record<BuyerRisk['grade'], 'green' | 'amber' | 'red' | 'slate'> = { A: 'green', B: 'amber', C: 'red', D: 'red', new: 'slate' };

const BuyerRiskCard: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const { data, error, setError, reload } = useReport<{ buyers: BuyerRisk[] }>('/api/buyers/risk', 'Could not load buyer payment records.');

  const setLimit = async (row: BuyerRisk) => {
    if (!row.buyerId) return;
    const entered = window.prompt(`Credit limit for ${row.buyerName} in USD (leave blank for no limit)`, row.creditLimitUsd === null ? '' : String(row.creditLimitUsd));
    if (entered === null) return;
    try {
      await api(`/api/buyers/${row.buyerId}/credit-limit`, sendJson('PUT', { creditLimitUsd: entered.trim() === '' ? null : entered.replace(/,/g, '') }));
      reload();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the credit limit.'));
    }
  };

  if (data && data.buyers.length === 0) return null;
  return (
    <Card title="Payment record and credit">
      <p className="text-xs text-slate-500 mb-3">
        How each buyer has paid so far, from issued invoices and recorded payments. When you issue an invoice to a buyer who is overdue,
        slow, or over their credit limit, the app warns you first.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? (
        <p className="text-sm text-slate-500">Loading...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <TableHead labels={['Buyer', 'Record', 'Outstanding', 'Overdue', 'Avg days late', 'Credit limit', '']} />
            <tbody>
              {data.buyers.map((row) => (
                <tr key={row.buyerName}>
                  <td className={cell}>
                    <p className="font-semibold">{row.buyerName}</p>
                    <p className="text-xs text-slate-500">
                      {row.invoices} invoices{row.lastInvoice ? ` · last ${row.lastInvoice}` : ''}
                    </p>
                  </td>
                  <td className={cell}>
                    <Badge tone={GRADE_TONE[row.grade]}>{row.gradeLabel}</Badge>
                    {row.onTimePercent !== null && <p className="text-xs text-slate-500 mt-1">{row.onTimePercent}% paid on time</p>}
                  </td>
                  <td className={`${cell} tabular-nums`}>{formatUsd(row.outstandingUsd)}</td>
                  <td className={`${cell} tabular-nums ${row.overdueUsd ? 'text-red-700 font-semibold' : ''}`}>
                    {row.overdueUsd ? formatUsd(row.overdueUsd) : '—'}
                    {row.maxDaysOverdue > 0 && <p className="text-xs font-normal">oldest {row.maxDaysOverdue} days</p>}
                  </td>
                  <td className={`${cell} tabular-nums`}>{row.avgDaysLate === null ? '—' : row.avgDaysLate}</td>
                  <td className={`${cell} tabular-nums`}>
                    {row.creditLimitUsd === null ? '—' : formatUsd(row.creditLimitUsd)}
                    {row.headroomUsd !== null && row.headroomUsd < 0 && <p className="text-xs text-red-700">over by {formatUsd(-row.headroomUsd)}</p>}
                  </td>
                  <td className={`${cell} text-right`}>
                    {isAdmin && row.buyerId && (
                      <button type="button" onClick={() => setLimit(row)} className={secondaryButton}>
                        Set limit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

export const BuyersPage: React.FC<{ readOnly?: boolean; isAdmin?: boolean }> = ({ readOnly = false, isAdmin = false }) => {
  const [buyers, setBuyers] = useState<Buyer[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; consignee: BuyerContact } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [portalBuyer, setPortalBuyer] = useState('');

  const load = () =>
    api<{ buyers: Buyer[] }>('/api/buyers')
      .then((result) => setBuyers(result.buyers))
      .catch((err) => setError(errorMessage(err, 'Could not load buyers.')));

  useEffect(() => {
    load();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const path = editing.id ? `/api/buyers/${editing.id}` : '/api/buyers';
      await api(path, sendJson(editing.id ? 'PUT' : 'POST', { consignee: editing.consignee }));
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the buyer.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (buyer: Buyer) => {
    if (!window.confirm(`Remove ${buyer.name} from the address book?`)) return;
    try {
      await api(`/api/buyers/${buyer.id}`, sendJson('DELETE'));
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the buyer.'));
    }
  };

  return (
    <Page
      title="Buyers"
      description="Saved consignees you can pick when creating an invoice."
      actions={
        !readOnly && (
          <button type="button" onClick={() => setEditing({ id: null, consignee: blankBuyer() })} className={primaryButton}>
            <Plus className="w-3.5 h-3.5" />
            Add buyer
          </button>
        )
      }
    >
      {error && <Notice tone="error">{error}</Notice>}

      {!readOnly && editing && (
        <Card title={editing.id ? 'Edit buyer' : 'New buyer'}>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {BUYER_KEYS.map((key) => (
              <Field
                key={key}
                label={LABELS[key]}
                value={editing.consignee[key]}
                required={key === 'companyName'}
                onChange={(value) => setEditing({ ...editing, consignee: { ...editing.consignee, [key]: value } })}
              />
            ))}
            <div className="md:col-span-3 flex gap-2">
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save buyer'}
              </button>
              <button type="button" onClick={() => setEditing(null)} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        {buyers === null ? (
          <p className="text-sm text-slate-500">Loading buyers...</p>
        ) : buyers.length === 0 ? (
          <p className="text-sm text-slate-500">
            No buyers yet. Add one here, or use "Save buyer" in the invoice workspace.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {buyers.map((buyer) => (
              <li key={buyer.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-semibold text-slate-950">{buyer.name}</p>
                  <p className="text-xs text-slate-500">
                    {[buyer.consignee.city, buyer.consignee.country, buyer.consignee.taxIdVat].filter(Boolean).join(' · ') ||
                      'No address details'}
                  </p>
                </div>
                {!readOnly && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: buyer.id, consignee: { ...blankBuyer(), ...buyer.consignee } })}
                    className={secondaryButton}
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => setPortalBuyer(buyer.name)} className={secondaryButton}>
                    Portal link
                  </button>
                  <button type="button" onClick={() => remove(buyer)} className={dangerButton}>
                    Remove
                  </button>
                </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <BuyerRiskCard isAdmin={isAdmin} />

      {!readOnly && buyers && buyers.length > 0 && (
        <PortalLinks buyerNames={buyers.map((buyer) => buyer.name)} selected={portalBuyer} onSelect={setPortalBuyer} />
      )}
    </Page>
  );
};
