import React, { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, errorMessage, sendJson, type PortalLink } from '../../api/client';
import { Card, Notice, dangerButton, inputClass, primaryButton, secondaryButton } from '../../components/ui';

/** Create, copy, and withdraw the private links that let a buyer see their own invoices. */
export const PortalLinks: React.FC<{ buyerNames: string[]; selected: string; onSelect: (name: string) => void }> = ({
  buyerNames,
  selected,
  onSelect,
}) => {
  const [links, setLinks] = useState<PortalLink[] | null>(null);
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<{ buyerName: string; url: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setLinks((await api<{ links: PortalLink[] }>('/api/portal-links')).links), []);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err, 'Could not load portal links.')));
  }, [load]);

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url: string }>('/api/portal-links', sendJson('POST', { buyerName: selected, days: Number(days) }));
      setCreated({ buyerName: selected, url: result.url });
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the link.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: PortalLink) => {
    if (!window.confirm(`Withdraw the portal link for ${link.buyerName}? It stops working straight away.`)) return;
    try {
      await api(`/api/portal-links/${link.id}`, sendJson('DELETE'));
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not withdraw the link.'));
    }
  };

  return (
    <Card title="Buyer portal links">
      <p className="text-sm text-slate-600">
        A private link lets a buyer see their own issued invoices, what is paid and still due, and download each invoice as PDF. No
        sign-in is needed, so share it only with the buyer. Withdraw it at any time.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-600 min-w-56">
          Buyer
          <select value={selected} onChange={(event) => onSelect(event.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Choose a buyer</option>
            {buyerNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600 w-28">
          Valid for
          <select value={days} onChange={(event) => setDays(event.target.value)} className={`${inputClass} mt-1`}>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
        <button type="button" onClick={create} disabled={busy || !selected} className={primaryButton}>
          Create link
        </button>
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {created && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="font-semibold text-emerald-900">Link for {created.buyerName}. Copy it now; it is not shown again.</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={created.url} className={inputClass} onFocus={(event) => event.target.select()} />
            <button type="button" onClick={() => navigator.clipboard?.writeText(created.url)} className={secondaryButton}>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </button>
          </div>
        </div>
      )}

      {links && links.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 text-sm">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="font-semibold">{link.buyerName}</p>
                <p className="text-xs text-slate-500">
                  {link.active ? `Works until ${new Date(link.expiresAt).toLocaleDateString()}` : link.revokedAt ? 'Withdrawn' : 'Expired'}
                  {' · '}
                  {link.lastViewedAt ? `last opened ${new Date(link.lastViewedAt).toLocaleString()}` : 'not opened yet'}
                  {link.createdBy && ` · created by ${link.createdBy}`}
                </p>
              </div>
              {link.active && (
                <button type="button" onClick={() => revoke(link)} className={dangerButton}>
                  Withdraw
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
