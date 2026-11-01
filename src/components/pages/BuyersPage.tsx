import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, errorMessage, sendJson, type Buyer, type BuyerContact } from '../../api/client';
import { BUYER_KEYS } from '../../utils/invoiceDefaults';
import { Card, Field, Notice, Page, dangerButton, primaryButton, secondaryButton } from '../ui';

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

export const BuyersPage: React.FC = () => {
  const [buyers, setBuyers] = useState<Buyer[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; consignee: BuyerContact } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
        <button type="button" onClick={() => setEditing({ id: null, consignee: blankBuyer() })} className={primaryButton}>
          <Plus className="w-3.5 h-3.5" />
          Add buyer
        </button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}

      {editing && (
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
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ id: buyer.id, consignee: { ...blankBuyer(), ...buyer.consignee } })}
                    className={secondaryButton}
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => remove(buyer)} className={dangerButton}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
};
