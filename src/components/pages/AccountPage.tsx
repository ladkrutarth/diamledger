import React, { useState } from 'react';
import { ROLE_LABEL, api, errorMessage, sendJson, type AuthUser } from '../../api/client';
import { Card, Field, Notice, Page, primaryButton } from '../ui';

export const AccountPage: React.FC<{ user: AuthUser }> = ({ user }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setMessage({ tone: 'error', text: 'The new passwords do not match.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api('/api/auth/change-password', sendJson('POST', { currentPassword, newPassword }));
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setMessage({ tone: 'success', text: 'Password changed. Other devices have been signed out.' });
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not change the password.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Account">
      <Card title="Signed in as">
        <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Email</dt>
          <dd className="font-medium">{user.email}</dd>
          <dt className="text-slate-500">Company</dt>
          <dd className="font-medium">{user.organizationName}</dd>
          <dt className="text-slate-500">Role</dt>
          <dd className="font-medium">{ROLE_LABEL[user.role]}</dd>
        </dl>
      </Card>

      <Card title="Change password" className="max-w-md">
        <form onSubmit={submit} className="space-y-3">
          <Field
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            required
            autoComplete="current-password"
          />
          <Field
            label="New password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <Field
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={setConfirm}
            required
            minLength={8}
            autoComplete="new-password"
          />
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Saving...' : 'Change password'}
          </button>
        </form>
      </Card>
    </Page>
  );
};
