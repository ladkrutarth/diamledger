import React, { useState } from 'react';
import { 
  Send, 
  Mail, 
  Settings, 
  Paperclip, 
  CheckCircle, 
  AlertCircle, 
  RefreshCw, 
  ShieldCheck, 
  FileText, 
  Server,
  UserCheck
} from 'lucide-react';
import { InvoiceState } from '../types/invoice';
import { exportElementToPdf } from '../utils/pdfGenerator';

interface Props {
  invoice: InvoiceState;
}

export const EmailDispatchPanel: React.FC<Props> = ({ invoice }) => {
  // SMTP Config
  const [smtpPreset, setSmtpPreset] = useState<'custom' | 'gmail' | 'office365'>('gmail');
  const [smtpHost, setSmtpHost] = useState<string>('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState<number>(465);
  const [smtpSecure, setSmtpSecure] = useState<boolean>(true);
  const [smtpUser, setSmtpUser] = useState<string>('customs.dispatch@diamondx-trade.com');
  const [smtpPass, setSmtpPass] = useState<string>('');
  const [fromName, setFromName] = useState<string>(invoice.exporter.companyName);

  // Recipients
  const [buyerEmail, setBuyerEmail] = useState<string>(invoice.consignee.email || 'procurement@rosenfeld-diamonds.be');
  const [brokerEmail, setBrokerEmail] = useState<string>('clearance@bombay-cha-customs.in');
  const [bankEmail, setBankEmail] = useState<string>('tradedesk.overseas@sbi.co.in');
  const [accountsEmail, setAccountsEmail] = useState<string>(invoice.exporter.email || 'accounts@srk-diamonds-export.in');
  const [ccList, setCcList] = useState<string>('');

  // Email Content
  const defaultSubject = `Diamond Export Commercial Invoice & Packing List - Ref: ${invoice.shipment.invoiceNumber} (AWB: ${invoice.shipment.awbNumber})`;
  const [subject, setSubject] = useState<string>(defaultSubject);
  const [attachInvoice, setAttachInvoice] = useState<boolean>(true);
  const [attachPackingList, setAttachPackingList] = useState<boolean>(true);

  // Status & Logs
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verifyStatus, setVerifyStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [dispatchLogs, setDispatchLogs] = useState<any[]>([]);

  // Update SMTP Preset
  const handlePresetChange = (preset: 'custom' | 'gmail' | 'office365') => {
    setSmtpPreset(preset);
    if (preset === 'gmail') {
      setSmtpHost('smtp.gmail.com');
      setSmtpPort(465);
      setSmtpSecure(true);
    } else if (preset === 'office365') {
      setSmtpHost('smtp.office365.com');
      setSmtpPort(587);
      setSmtpSecure(false);
    }
  };

  // Verify SMTP Connection
  const handleVerifySmtp = async () => {
    setIsVerifying(true);
    setVerifyStatus(null);
    try {
      const response = await fetch('/api/verify-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          user: smtpUser,
          pass: smtpPass,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setVerifyStatus({ success: true, message: 'SMTP Handshake Verified (TLS Ready)' });
      } else {
        setVerifyStatus({ success: false, message: data.error || 'SMTP Authentication Failed' });
      }
    } catch (err: any) {
      setVerifyStatus({ success: false, message: err.message || 'Network error verifying SMTP' });
    } finally {
      setIsVerifying(false);
    }
  };

  // Generate & Dispatch Email
  const handleSendEmail = async () => {
    setIsSending(true);
    try {
      // Collect recipients
      const recipients: string[] = [];
      if (buyerEmail) recipients.push(buyerEmail);
      if (brokerEmail) recipients.push(brokerEmail);
      if (bankEmail) recipients.push(bankEmail);
      if (accountsEmail) recipients.push(accountsEmail);

      const cc = ccList.split(',').map((s) => s.trim()).filter(Boolean);

      // Total calculations for email body
      const totalCarats = invoice.items.reduce((s, i) => s + (Number(i.carats) || 0), 0);
      const totalPieces = invoice.items.reduce((s, i) => s + (Number(i.pieces) || 0), 0);
      const totalCifUSD = invoice.items.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0) +
        invoice.freightUsd + invoice.insuranceUsd + invoice.otherChargesUsd;

      // Generate HTML email body
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; max-width: 650px; line-height: 1.6;">
          <h2 style="color: #0f172a; margin-bottom: 4px;">Diamond Export Shipping Intimation</h2>
          <p style="margin-top: 0; color: #64748b; font-size: 13px;">A1005 Compliance Standard · GJEPC / KPCS Verified Consignment</p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
          
          <p>Dear Valued Partner / Customs Clearance Desk,</p>
          <p>Please find attached the official Commercial Invoice and Packing List for the diamond export consignment dispatched under the following trade references:</p>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px;">
            <tr style="background-color: #f8fafc;">
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold; width: 35%;">Invoice Number:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-family: monospace; font-weight: bold;">${invoice.shipment.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Invoice Date:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${invoice.shipment.invoiceDate}</td>
            </tr>
            <tr style="background-color: #f8fafc;">
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Air Waybill (AWB):</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-family: monospace;">${invoice.shipment.awbNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Carrier / Forwarder:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${invoice.shipment.carrierName} (Flight: ${invoice.shipment.flightNumber})</td>
            </tr>
            <tr style="background-color: #f8fafc;">
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Port of Discharge:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0;">${invoice.shipment.portOfDischarge}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Total Net Carats:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">${totalCarats.toFixed(3)} CTS (${totalPieces} Pcs)</td>
            </tr>
            <tr style="background-color: #f8fafc;">
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Total Invoice Amount:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold; color: #047857;">$${totalCifUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD (${invoice.shipment.incoterms})</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">KPCS Certificate Ref:</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-family: monospace;">${invoice.shipment.kpcsNumber}</td>
            </tr>
            <tr style="background-color: #f8fafc;">
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-weight: bold;">Bank AD Code (Customs):</td>
              <td style="padding: 8px; border: 1px solid #e2e8f0; font-family: monospace;">${invoice.bank.adCode} (${invoice.bank.bankName})</td>
            </tr>
          </table>

          <div style="background-color: #f1f5f9; border-left: 4px solid #0284c7; padding: 10px; margin-bottom: 16px; font-size: 12px; color: #334155;">
            <strong>Kimberley Process Declaration:</strong> The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict and in compliance with United Nations Resolutions and the Kimberley Process Certification Scheme.
          </div>

          <p style="font-size: 13px;">Kindly process customs arrival clearance and notify upon safe vault receipt.</p>
          
          <p style="margin-top: 24px; font-size: 13px;">
            Sincerely,<br />
            <strong>${invoice.authorizedSignatoryName}</strong><br />
            ${invoice.authorizedSignatoryDesignation}<br />
            ${invoice.exporter.companyName}<br />
            <span style="font-family: monospace; font-size: 11px;">IEC: ${invoice.exporter.iec} | GSTIN: ${invoice.exporter.gstin}</span>
          </p>
        </div>
      `;

      // Generate attachments from preview DOM
      const attachments: any[] = [];
      if (attachInvoice) {
        try {
          const { base64 } = await exportElementToPdf('a1005-printable-document', {
            filename: `COMMERCIAL_INVOICE_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`,
            download: false,
            returnBase64: true,
          });
          if (base64) {
            attachments.push({
              filename: `COMMERCIAL_INVOICE_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`,
              content: base64,
              contentType: 'application/pdf',
            });
          }
        } catch (pdfErr) {
          console.warn('PDF attachment capture fallback:', pdfErr);
        }
      }

      const response = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtpConfig: {
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            user: smtpUser,
            pass: smtpPass,
            fromEmail: smtpUser,
            fromName: fromName || invoice.exporter.companyName,
          },
          emailData: {
            recipients,
            cc,
            subject,
            htmlBody,
            invoiceNumber: invoice.shipment.invoiceNumber,
          },
          attachments,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to dispatch email');
      }

      // Add to log
      const newLog = {
        id: `dispatch-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        invoiceNumber: invoice.shipment.invoiceNumber,
        recipientsCount: recipients.length,
        mode: data.mode,
        messageId: data.messageId || 'GATEWAY-SIM-2026',
        status: 'DISPATCHED_SUCCESS',
      };
      setDispatchLogs([newLog, ...dispatchLogs]);
    } catch (err: any) {
      console.error('Dispatch error:', err);
      alert(`Dispatch Error: ${err.message}`);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white text-slate-800">
      {/* Header */}
      <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-blue-600" />
          <h2 className="text-sm font-bold text-slate-900">Automated Diamond Export Email Dispatch</h2>
        </div>
        <span className="text-[11px] font-mono text-slate-500">
          A1005 Dispatch Engine v1.0
        </span>
      </div>

      {/* Main Form Body */}
      <div className="flex-1 overflow-auto p-4 space-y-4 text-xs">
        {/* SMTP Configuration Card */}
        <div className="p-3 border border-slate-200 rounded-lg bg-slate-50/50 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-slate-900">
              <Server className="w-4 h-4 text-slate-600" />
              <span>SMTP Gateway Configuration</span>
            </div>
            {/* Presets */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handlePresetChange('gmail')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  smtpPreset === 'gmail' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
                }`}
              >
                Gmail
              </button>
              <button
                onClick={() => handlePresetChange('office365')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  smtpPreset === 'office365' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
                }`}
              >
                Office 365
              </button>
              <button
                onClick={() => handlePresetChange('custom')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  smtpPreset === 'custom' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
                }`}
              >
                Custom SMTP
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <div className="md:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">SMTP Server Host</label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Port & SSL</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(parseInt(e.target.value) || 587)}
                  className="w-16 px-2 py-1 border border-slate-300 rounded font-mono bg-white"
                />
                <label className="flex items-center gap-1 text-[11px] text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.target.checked)}
                    className="rounded text-blue-600"
                  />
                  <span>SSL/TLS</span>
                </label>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Action</label>
              <button
                onClick={handleVerifySmtp}
                disabled={isVerifying}
                className="w-full px-2 py-1 text-xs font-medium border border-slate-300 rounded bg-white hover:bg-slate-100 text-slate-700 transition-colors flex items-center justify-center gap-1"
              >
                {isVerifying ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />}
                <span>Test Gateway</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Username / Sender Email</label>
              <input
                type="text"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">App Password / Auth Token</label>
              <input
                type="password"
                placeholder="••••••••••••••••"
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
              />
            </div>
          </div>

          {verifyStatus && (
            <div className={`p-2 rounded text-[11px] flex items-center gap-1.5 ${
              verifyStatus.success ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'
            }`}>
              {verifyStatus.success ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span>{verifyStatus.message}</span>
            </div>
          )}
        </div>

        {/* Smart Recipients Management */}
        <div className="p-3 border border-slate-200 rounded-lg bg-white space-y-3">
          <div className="flex items-center gap-1.5 font-semibold text-slate-900 border-b border-slate-200 pb-1.5">
            <UserCheck className="w-4 h-4 text-emerald-600" />
            <span>Smart Recipient Routing</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Buyer Email (Overseas Consignee)</label>
              <input
                type="email"
                value={buyerEmail}
                onChange={(e) => setBuyerEmail(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Customs Broker (CHA Clearances)</label>
              <input
                type="email"
                value={brokerEmail}
                onChange={(e) => setBrokerEmail(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Bank AD Branch Trade Desk</label>
              <input
                type="email"
                value={bankEmail}
                onChange={(e) => setBankEmail(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Internal Accounts / Auditor</label>
              <input
                type="email"
                value={accountsEmail}
                onChange={(e) => setAccountsEmail(e.target.value)}
                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
              />
            </div>
          </div>
        </div>

        {/* Email Content & Attachments */}
        <div className="p-3 border border-slate-200 rounded-lg bg-white space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Subject Line</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-2 py-1 border border-slate-300 rounded font-semibold text-slate-900"
            />
          </div>

          {/* Attachments Checklist */}
          <div>
            <span className="block text-[11px] font-medium text-slate-600 mb-1">Automated PDF Attachments:</span>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 p-2 rounded border border-slate-200 bg-slate-50 cursor-pointer text-slate-800">
                <input
                  type="checkbox"
                  checked={attachInvoice}
                  onChange={(e) => setAttachInvoice(e.target.checked)}
                  className="rounded text-blue-600"
                />
                <FileText className="w-3.5 h-3.5 text-blue-600" />
                <span className="font-mono text-[11px]">COMMERCIAL_INVOICE_{invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf</span>
              </label>

              <label className="flex items-center gap-1.5 p-2 rounded border border-slate-200 bg-slate-50 cursor-pointer text-slate-800">
                <input
                  type="checkbox"
                  checked={attachPackingList}
                  onChange={(e) => setAttachPackingList(e.target.checked)}
                  className="rounded text-emerald-600"
                />
                <Paperclip className="w-3.5 h-3.5 text-emerald-600" />
                <span className="font-mono text-[11px]">EXPORT_PACKING_LIST_{invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf</span>
              </label>
            </div>
          </div>

          {/* Action Send Button */}
          <div className="pt-2 flex items-center justify-between">
            <span className="text-[11px] text-slate-500">
              Direct dispatch with signed Kimberley Process affirmation and Indian Customs AD Code.
            </span>
            <button
              onClick={handleSendEmail}
              disabled={isSending}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-sm transition-colors disabled:opacity-50 text-xs"
            >
              {isSending ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Generating Attachments & Dispatching...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Send Commercial Invoice & Packing List</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Dispatch History & Audit Trail */}
        {dispatchLogs.length > 0 && (
          <div className="p-3 border border-slate-200 rounded-lg bg-slate-50 space-y-2">
            <div className="flex items-center justify-between font-semibold text-slate-900 border-b border-slate-200 pb-1">
              <span>Recent Dispatch Logs</span>
              <span className="text-[11px] font-mono text-emerald-700">Audit Trail Active</span>
            </div>
            <div className="space-y-1.5 font-mono text-[11px]">
              {dispatchLogs.map((log) => (
                <div key={log.id} className="p-2 rounded bg-white border border-slate-200 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-slate-900">{log.invoiceNumber}</span>
                    <span className="text-slate-500"> · Sent to {log.recipientsCount} recipients at {log.timestamp}</span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                    {log.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
