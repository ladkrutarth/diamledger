import React, { useEffect, useState } from 'react';
import { ROLE_LABEL, api, errorMessage, sendJson, type OutsideAccountant, type Role, type TeamMember } from '../../api/client';
import { Card, Field, Notice, Page, dangerButton, inputClass, primaryButton, secondaryButton } from '../../components/ui';

interface Props {
  currentUserId: string;
}

export const TeamPage: React.FC<Props> = ({ currentUserId }) => {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<TeamMember | null>(null);
  const [adminPassword, setAdminPassword] = useState('');

  const load = () =>
    api<{ members: TeamMember[] }>('/api/team/members')
      .then((result) => setMembers(result.members))
      .catch((err) => setMessage({ tone: 'error', text: errorMessage(err, 'Could not load the team.') }));

  useEffect(() => {
    load();
  }, []);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api('/api/team/members', sendJson('POST', { email, password, role }));
      setMessage({
        tone: 'success',
        text: `${email} can now sign in with the temporary password. Ask them to change it under Account.`,
      });
      setEmail('');
      setPassword('');
      setRole('member');
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not add the team member.') });
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (member: TeamMember, nextRole: Role) => {
    setMessage(null);
    try {
      await api(`/api/team/members/${member.id}`, sendJson('PATCH', { role: nextRole }));
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not change the role.') });
    }
  };

  const remove = async (member: TeamMember) => {
    if (!window.confirm(`Remove ${member.email}? Their invoices stay with the company.`)) return;
    setMessage(null);
    try {
      await api(`/api/team/members/${member.id}`, sendJson('DELETE'));
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not remove the team member.') });
    }
  };

  const resetTwoFactor = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetting) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/team/members/${resetting.id}/two-factor/reset`, sendJson('POST', { password: adminPassword }));
      setMessage({
        tone: 'success',
        text: `Two-step sign-in is off for ${resetting.email}, and they have been signed out. They can now sign in with their password; ask them to turn two-step on again under Account.`,
      });
      setResetting(null);
      setAdminPassword('');
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not reset two-step sign-in.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Team"
      description="Admins manage the company. Members run the export desk. A tax accountant prepares the GST register. A chartered accountant reviews the books and can close a month."
    >
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card title="Add a team member">
        <form onSubmit={add} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <Field label="Email" type="email" value={email} onChange={setEmail} required autoComplete="off" />
          <Field
            label="Temporary password"
            type="text"
            value={password}
            onChange={setPassword}
            required
            minLength={8}
            autoComplete="off"
          />
          <div>
            <label htmlFor="new-member-role" className="block text-[11px] font-semibold text-slate-600 mb-1">
              Role
            </label>
            <select
              id="new-member-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className={inputClass}
            >
              {(Object.keys(ROLE_LABEL) as Role[]).map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={busy} className={`${primaryButton} justify-center py-2`}>
            {busy ? 'Adding...' : 'Add member'}
          </button>
        </form>
      </Card>

      <Card title="Members">
        {members === null ? (
          <p className="text-sm text-slate-500">Loading team...</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-semibold text-slate-950">
                    {member.email}
                    {member.id === currentUserId && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    Added {member.createdAt.slice(0, 10)}
                    {member.twoFactor && <span className="ml-2 font-semibold text-emerald-700">Two-step on</span>}
                  </p>
                  {resetting?.id === member.id && (
                    <form onSubmit={resetTwoFactor} className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="w-56">
                        <Field
                          label="Your password, to confirm"
                          type="password"
                          value={adminPassword}
                          onChange={setAdminPassword}
                          required
                          autoComplete="current-password"
                        />
                      </div>
                      <button type="submit" disabled={busy} className={dangerButton}>
                        Turn off their two-step
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetting(null);
                          setAdminPassword('');
                        }}
                        className={secondaryButton}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    onChange={(event) => changeRole(member, event.target.value as Role)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    {(Object.keys(ROLE_LABEL) as Role[]).map((value) => (
                      <option key={value} value={value}>
                        {ROLE_LABEL[value]}
                      </option>
                    ))}
                  </select>
                  {member.twoFactor && member.id !== currentUserId && resetting?.id !== member.id && (
                    <button
                      type="button"
                      title="For someone who lost their phone and their recovery codes"
                      onClick={() => {
                        setResetting(member);
                        setAdminPassword('');
                      }}
                      className={secondaryButton}
                    >
                      Reset two-step
                    </button>
                  )}
                  {member.id !== currentUserId && (
                    <button type="button" onClick={() => remove(member)} className={dangerButton}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <OutsideAccountants />
    </Page>
  );
};

const OutsideAccountants: React.FC = () => {
  const [accountants, setAccountants] = useState<OutsideAccountant[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ca' | 'tax'>('ca');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ accountants: OutsideAccountant[] }>('/api/team/accountants')
      .then((result) => setAccountants(result.accountants))
      .catch((err) => setError(errorMessage(err, 'Could not load outside accountants.')));

  useEffect(() => {
    load();
  }, []);

  const grant = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/team/accountants', sendJson('POST', { email, role }));
      setEmail('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not give access.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (accountant: OutsideAccountant) => {
    if (!window.confirm(`Remove ${accountant.email}'s access to this company?`)) return;
    setError('');
    try {
      await api(`/api/team/accountants/${accountant.userId}`, sendJson('DELETE'));
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not remove access.'));
    }
  };

  return (
    <Card title="Outside accountants">
      <p className="text-sm text-slate-600 mb-3">
        Give your CA firm access without adding them to your team. They keep their own login, switch between all the companies they look
        after, and see every company's due dates in one calendar. They must already have an account here.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={grant} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Field label="Accountant's email" type="email" value={email} onChange={setEmail} required />
        </div>
        <label className="text-[11px] font-semibold text-slate-600">
          Access
          <select value={role} onChange={(event) => setRole(event.target.value as 'ca' | 'tax')} className={`${inputClass} mt-1`}>
            <option value="ca">{ROLE_LABEL.ca}</option>
            <option value="tax">{ROLE_LABEL.tax}</option>
          </select>
        </label>
        <button type="submit" disabled={busy} className={secondaryButton}>
          Give access
        </button>
      </form>
      {accountants && accountants.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100">
          {accountants.map((accountant) => (
            <li key={accountant.userId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div>
                <p className="font-semibold text-slate-950">{accountant.email}</p>
                <p className="text-xs text-slate-500">
                  {accountant.firm} · {ROLE_LABEL[accountant.role]} since {accountant.createdAt.slice(0, 10)}
                </p>
              </div>
              <button type="button" onClick={() => revoke(accountant)} className={dangerButton}>
                Remove access
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};
