import React, { useEffect, useState } from 'react';
import { api, errorMessage, sendJson, type Company, type CompanyProfile } from '../../api/client';
import type { BankDetails, ExporterDetails } from '../../types/invoice';
import { Card, Field, Notice, Page, primaryButton } from '../ui';

const EXPORTER_FIELDS: Array<[keyof ExporterDetails, string]> = [
  ['companyName', 'Legal company name'],
  ['addressLine1', 'Address line 1'],
  ['addressLine2', 'Address line 2'],
  ['city', 'City'],
  ['state', 'State'],
  ['stateCode', 'State code'],
  ['pincode', 'PIN code'],
  ['country', 'Country'],
  ['iec', 'IEC'],
  ['gstin', 'GSTIN'],
  ['pan', 'PAN'],
  ['rcmcNo', 'GJEPC RCMC number'],
  ['email', 'Email'],
  ['phone', 'Phone'],
];

const BANK_FIELDS: Array<[keyof BankDetails, string]> = [
  ['bankName', 'Bank name'],
  ['branch', 'Branch'],
  ['accountNumber', 'Account number'],
  ['adCode', 'AD code'],
  ['swiftCode', 'SWIFT code'],
  ['ifscCode', 'IFSC code'],
  ['iban', 'IBAN'],
  ['correspondentBank', 'Correspondent bank'],
  ['correspondentSwift', 'Correspondent SWIFT'],
];

const EMPTY_PROFILE: CompanyProfile = {
  invoicePrefix: 'EXP',
  authorizedSignatoryName: '',
  authorizedSignatoryDesignation: '',
  exporter: {},
  bank: {},
};

interface Props {
  isAdmin: boolean;
  onSaved: (company: Company) => void;
}

export const CompanyPage: React.FC<Props> = ({ isAdmin, onSaved }) => {
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<CompanyProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Company>('/api/company')
      .then((company) => {
        setName(company.name);
        setProfile({ ...EMPTY_PROFILE, ...(company.profile ?? {}) });
        setLoaded(true);
      })
      .catch((err) => setMessage({ tone: 'error', text: errorMessage(err, 'Could not load the company profile.') }));
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<Company>('/api/company', sendJson('PUT', { name, profile }));
      setProfile({ ...EMPTY_PROFILE, ...(saved.profile ?? {}) });
      onSaved(saved);
      setMessage({ tone: 'success', text: 'Company profile saved. New invoices will use these details.' });
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not save the company profile.') });
    } finally {
      setBusy(false);
    }
  };

  const section = <K extends 'exporter' | 'bank'>(key: K, fields: Array<[string, string]>) =>
    fields.map(([field, label]) => (
      <Field
        key={field}
        label={label}
        value={(profile[key] as Record<string, string | undefined>)[field] ?? ''}
        onChange={(value) => setProfile({ ...profile, [key]: { ...profile[key], [field]: value } })}
      />
    ));

  return (
    <Page
      title="Company profile"
      description="Exporter and bank details filled in automatically on every new invoice."
    >
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {!isAdmin && <Notice>Only company admins can change these details.</Notice>}
      {loaded && (
        <form onSubmit={save} className="space-y-4">
          <fieldset disabled={!isAdmin} className="space-y-4">
            <Card title="Company and numbering">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Field label="Company name in this app" value={name} onChange={setName} required />
                <Field
                  label="Invoice number prefix"
                  value={profile.invoicePrefix}
                  placeholder="EXP"
                  onChange={(value) => setProfile({ ...profile, invoicePrefix: value })}
                />
                <div className="text-xs text-slate-500 self-end pb-2">
                  Next numbers look like{' '}
                  <span className="font-mono font-semibold text-slate-800">
                    {(profile.invoicePrefix || 'EXP').replace(/[^A-Za-z0-9-]/g, '')}/2026-27/0001
                  </span>
                </div>
                <Field
                  label="Authorised signatory"
                  value={profile.authorizedSignatoryName}
                  onChange={(value) => setProfile({ ...profile, authorizedSignatoryName: value })}
                />
                <Field
                  label="Signatory designation"
                  value={profile.authorizedSignatoryDesignation}
                  onChange={(value) => setProfile({ ...profile, authorizedSignatoryDesignation: value })}
                />
              </div>
            </Card>
            <Card title="Exporter details">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">{section('exporter', EXPORTER_FIELDS)}</div>
            </Card>
            <Card title="Bank details">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">{section('bank', BANK_FIELDS)}</div>
            </Card>
            {isAdmin && (
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? 'Saving...' : 'Save company profile'}
              </button>
            )}
          </fieldset>
        </form>
      )}
    </Page>
  );
};
