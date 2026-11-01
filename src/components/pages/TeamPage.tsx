import React, { useEffect, useState } from 'react';
import { api, errorMessage, sendJson, type Role, type TeamMember } from '../../api/client';
import { Card, Field, Notice, Page, dangerButton, inputClass, primaryButton } from '../ui';

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

  return (
    <Page
      title="Team"
      description="Admins manage the company profile, team, deletions, and cancellations. Members create and issue invoices."
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
              <option value="member">Member</option>
              <option value="admin">Admin</option>
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
                  <p className="text-xs text-slate-500">Added {member.createdAt.slice(0, 10)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    onChange={(event) => changeRole(member, event.target.value as Role)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
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
    </Page>
  );
};
