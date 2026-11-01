import React, { useState } from 'react';
import { 
  Download, 
  Copy, 
  Check, 
  Layers, 
  FileCode, 
  Database, 
  CheckCircle2, 
  ExternalLink,
  Code2
} from 'lucide-react';
import { InvoiceState } from '../types/invoice';
import { generateTallyPrimeXML } from '../utils/tallyGenerator';
import { generateSapODataPayload } from '../utils/sapGenerator';

interface Props {
  invoice: InvoiceState;
}

export const ErpSyncPanel: React.FC<Props> = ({ invoice }) => {
  const [activeSystem, setActiveSystem] = useState<'tally' | 'sap'>('tally');
  const [copied, setCopied] = useState<boolean>(false);

  const tallyXml = generateTallyPrimeXML(invoice);
  const sapPayload = generateSapODataPayload(invoice);
  const sapJson = JSON.stringify(sapPayload, null, 2);

  const currentContent = activeSystem === 'tally' ? tallyXml : sapJson;
  const currentFilename = activeSystem === 'tally' 
    ? `Tally_SalesVoucher_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.xml`
    : `SAP_SalesOrder_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.json`;

  const handleCopy = () => {
    navigator.clipboard.writeText(currentContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([currentContent], { 
      type: activeSystem === 'tally' ? 'application/xml;charset=utf-8' : 'application/json;charset=utf-8' 
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = currentFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full bg-white text-slate-800">
      {/* Top Selector Bar */}
      <div className="p-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-1.5 p-0.5 bg-slate-200/70 rounded-lg text-xs font-semibold">
          <button
            onClick={() => setActiveSystem('tally')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
              activeSystem === 'tally'
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-blue-600" />
            <span>Tally Prime XML (Sales LUT)</span>
          </button>
          <button
            onClick={() => setActiveSystem('sap')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
              activeSystem === 'sap'
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Database className="w-3.5 h-3.5 text-emerald-600" />
            <span>SAP S/4HANA OData / REST</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied!' : 'Copy Code'}</span>
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download {activeSystem === 'tally' ? '.XML' : '.JSON'}</span>
          </button>
        </div>
      </div>

      {/* Overview Specs */}
      <div className="p-3 bg-slate-100/70 border-b border-slate-200 text-xs">
        {activeSystem === 'tally' ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-bold text-slate-900">Tally Prime Standard Sales Voucher: </span>
              <span className="text-slate-600 font-mono">
                LUT ARN: {invoice.shipment.lutNumber} · Currency: USD · UOM: CTS · HSN: 7102.39.10
              </span>
            </div>
            <div className="text-[11px] text-slate-500 font-mono">
              Import Path: Gateway of Tally → Import → Transactions → XML Format
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-bold text-slate-900">SAP S/4HANA OData Service: </span>
              <span className="text-slate-600 font-mono">
                API_SALES_ORDER_SRV · Type: OR_EXP · Category: ZTAN · Incoterms: {invoice.shipment.incoterms}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 font-mono">
              Endpoint: /sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder
            </div>
          </div>
        )}
      </div>

      {/* Code Editor / Viewer */}
      <div className="flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs text-slate-200 selection:bg-blue-800 selection:text-white">
        <pre className="whitespace-pre leading-relaxed">{currentContent}</pre>
      </div>

      {/* Field Mapping Guide Footer */}
      <div className="p-3 border-t border-slate-200 bg-white text-xs space-y-2">
        <span className="font-bold text-slate-800 block text-[11px] uppercase tracking-wider">
          Compliance & Field Mapping Invariants:
        </span>
        {activeSystem === 'tally' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-slate-600">
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Forex Ledger</strong>
              Multi-currency voucher debiting buyer ledger in USD and converting at ₹{invoice.exchangeRateInr.toFixed(2)}/USD to comply with Rule 34.
            </div>
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Stock UOM Carats</strong>
              Stock items mapped to Unit of Measurement <code className="text-blue-700">CTS</code> with HSN 7102.39.10 and batch lot tracking.
            </div>
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Export Narration</strong>
              Auto-populates mandatory customs declarations, Kimberley Scheme certificate number, and AD code in the narration line.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-slate-600">
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Partner Functions</strong>
              Sold-To Party (SP), Ship-To Party (SH), and Armoured Carrier / Forwarding Agent (CR: {invoice.shipment.carrierName}).
            </div>
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Pricing Elements</strong>
              Condition Type <code className="text-blue-700">PR00</code> for Base Price per carat and <code className="text-emerald-700">ZEXP</code> for 0% export GST under LUT.
            </div>
            <div className="p-2 border border-slate-200 rounded bg-slate-50">
              <strong className="text-slate-900 block font-mono">Customs Texts</strong>
              Header text ID <code className="text-blue-700">0001</code> containing Kimberley certificate and LUT ARN for SAP GTS (Global Trade Services).
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
