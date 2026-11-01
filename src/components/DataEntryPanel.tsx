import React, { useState } from 'react';
import { 
  Plus, 
  Trash2, 
  Copy, 
  Sparkles, 
  Building2, 
  UserCheck, 
  Plane, 
  CreditCard, 
  ShieldAlert, 
  Settings2,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { InvoiceState, DiamondItem } from '../types/invoice';
import { 
  SURAT_TO_ANTWERP_PRESET, 
  MUMBAI_TO_NY_PRESET, 
  SURAT_TO_DUBAI_PRESET 
} from '../data/sampleInvoices';

interface Props {
  invoice: InvoiceState;
  onChange: (updated: InvoiceState) => void;
  onOpenAiParser: () => void;
}

export const DataEntryPanel: React.FC<Props> = ({ invoice, onChange, onOpenAiParser }) => {
  const [activeTab, setActiveTab] = useState<'items' | 'parties' | 'shipping' | 'bank' | 'clauses'>('items');

  // Handle adding new item
  const handleAddItem = () => {
    const newItem: DiamondItem = {
      id: `item-${Date.now()}`,
      srNo: invoice.items.length + 1,
      description: 'Cut & Polished Natural Earth-Mined Diamonds',
      shape: 'Round Brilliant',
      colorClarity: 'G-H / VS',
      cutGrade: 'EX',
      hsCode: '7102.39.10',
      certificateNo: 'GIA PENDING',
      parcelId: `LOT-${String(invoice.items.length + 1).padStart(2, '0')}`,
      pieces: 1,
      carats: 1.0,
      ratePerCarat: 3000,
      totalAmount: 3000,
    };
    onChange({
      ...invoice,
      items: [...invoice.items, newItem],
    });
  };

  const handleUpdateItem = (index: number, field: keyof DiamondItem, value: any) => {
    const updatedItems = [...invoice.items];
    const current = { ...updatedItems[index], [field]: value };

    // Auto calculate total if carats or rate change
    if (field === 'carats' || field === 'ratePerCarat') {
      const c = field === 'carats' ? parseFloat(value) || 0 : current.carats;
      const r = field === 'ratePerCarat' ? parseFloat(value) || 0 : current.ratePerCarat;
      current.totalAmount = Math.round(c * r * 100) / 100;
    }

    updatedItems[index] = current;
    onChange({ ...invoice, items: updatedItems });
  };

  const handleDeleteItem = (index: number) => {
    if (invoice.items.length <= 1) return;
    const updated = invoice.items.filter((_, i) => i !== index).map((item, i) => ({
      ...item,
      srNo: i + 1,
    }));
    onChange({ ...invoice, items: updated });
  };

  const handleDuplicateItem = (index: number) => {
    const target = invoice.items[index];
    const cloned: DiamondItem = {
      ...target,
      id: `item-${Date.now()}`,
      srNo: invoice.items.length + 1,
      parcelId: `${target.parcelId}-COPY`,
    };
    onChange({ ...invoice, items: [...invoice.items, cloned] });
  };

  const handleApplyPreset = (presetName: string) => {
    if (presetName === 'surat') onChange(SURAT_TO_ANTWERP_PRESET);
    else if (presetName === 'mumbai') onChange(MUMBAI_TO_NY_PRESET);
    else if (presetName === 'dubai') onChange(SURAT_TO_DUBAI_PRESET);
  };

  return (
    <div className="flex flex-col h-full bg-white text-slate-800">
      {/* Header Bar with Presets & AI Trigger */}
      <div className="p-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-700">Quick Trade Presets:</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleApplyPreset('surat')}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 bg-white hover:bg-slate-100 transition-colors text-slate-700"
            >
              Surat → Antwerp
            </button>
            <button
              onClick={() => handleApplyPreset('mumbai')}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 bg-white hover:bg-slate-100 transition-colors text-slate-700"
            >
              Mumbai BDB → New York
            </button>
            <button
              onClick={() => handleApplyPreset('dubai')}
              className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 bg-white hover:bg-slate-100 transition-colors text-slate-700"
            >
              Surat SEZ → Dubai
            </button>
          </div>
        </div>

        <button
          onClick={onOpenAiParser}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
          <span>AI Manifest Parser</span>
        </button>
      </div>

      {/* Sub Tabs */}
      <div className="flex border-b border-slate-200 px-3 bg-white text-xs font-medium text-slate-600">
        <button
          onClick={() => setActiveTab('items')}
          className={`py-2 px-3 border-b-2 font-medium transition-colors ${
            activeTab === 'items'
              ? 'border-slate-900 text-slate-950 font-semibold'
              : 'border-transparent hover:text-slate-900'
          }`}
        >
          Diamond Items ({invoice.items.length})
        </button>
        <button
          onClick={() => setActiveTab('parties')}
          className={`py-2 px-3 border-b-2 font-medium transition-colors ${
            activeTab === 'parties'
              ? 'border-slate-900 text-slate-950 font-semibold'
              : 'border-transparent hover:text-slate-900'
          }`}
        >
          Exporter & Buyer
        </button>
        <button
          onClick={() => setActiveTab('shipping')}
          className={`py-2 px-3 border-b-2 font-medium transition-colors ${
            activeTab === 'shipping'
              ? 'border-slate-900 text-slate-950 font-semibold'
              : 'border-transparent hover:text-slate-900'
          }`}
        >
          Shipping & Logistics
        </button>
        <button
          onClick={() => setActiveTab('bank')}
          className={`py-2 px-3 border-b-2 font-medium transition-colors ${
            activeTab === 'bank'
              ? 'border-slate-900 text-slate-950 font-semibold'
              : 'border-transparent hover:text-slate-900'
          }`}
        >
          Bank & AD Code
        </button>
        <button
          onClick={() => setActiveTab('clauses')}
          className={`py-2 px-3 border-b-2 font-medium transition-colors ${
            activeTab === 'clauses'
              ? 'border-slate-900 text-slate-950 font-semibold'
              : 'border-transparent hover:text-slate-900'
          }`}
        >
          KPCS Declarations
        </button>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-auto p-4">
        {/* DIAMOND ITEMS TAB */}
        {activeTab === 'items' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Diamond Parcel Line Items</h3>
                <p className="text-xs text-slate-500">
                  Cut & Polished Natural Diamonds (HSN 7102.39.10) with GIA/IGI certificates and carats
                </p>
              </div>
              <button
                onClick={handleAddItem}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Lot</span>
              </button>
            </div>

            {/* Items Table Form */}
            <div className="space-y-3">
              {invoice.items.map((item, index) => (
                <div 
                  key={item.id || index}
                  className="p-3 border border-slate-200 rounded-lg bg-slate-50/50 space-y-2.5 text-xs"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
                    <span className="font-mono font-bold text-slate-700">
                      Item #{index + 1} · {item.parcelId || `LOT-${index + 1}`}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDuplicateItem(index)}
                        className="p-1 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded"
                        title="Duplicate item"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteItem(index)}
                        disabled={invoice.items.length <= 1}
                        className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-30"
                        title="Delete item"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Row 1: Description & HS Code */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                    <div className="md:col-span-3">
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Description of Goods</label>
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) => handleUpdateItem(index, 'description', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-medium"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">HS / HSN Code</label>
                      <input
                        type="text"
                        value={item.hsCode}
                        onChange={(e) => handleUpdateItem(index, 'hsCode', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono"
                      />
                    </div>
                  </div>

                  {/* Row 2: Grading & Certificate */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Shape / Cut</label>
                      <input
                        type="text"
                        placeholder="Round Brilliant, Oval, Emerald"
                        value={item.shape || ''}
                        onChange={(e) => handleUpdateItem(index, 'shape', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Color / Clarity</label>
                      <input
                        type="text"
                        placeholder="D-F / VVS1"
                        value={item.colorClarity || ''}
                        onChange={(e) => handleUpdateItem(index, 'colorClarity', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Lab Certificate / GIA No.</label>
                      <input
                        type="text"
                        placeholder="GIA 2489104821"
                        value={item.certificateNo}
                        onChange={(e) => handleUpdateItem(index, 'certificateNo', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Parcel / Lot ID</label>
                      <input
                        type="text"
                        placeholder="LOT-101"
                        value={item.parcelId}
                        onChange={(e) => handleUpdateItem(index, 'parcelId', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono"
                      />
                    </div>
                  </div>

                  {/* Row 3: Pieces, Carats, Rate, Total */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 border-t border-slate-200">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Pieces (Pcs)</label>
                      <input
                        type="number"
                        min="1"
                        value={item.pieces}
                        onChange={(e) => handleUpdateItem(index, 'pieces', parseInt(e.target.value) || 1)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Net Carats (cts)</label>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={item.carats}
                        onChange={(e) => handleUpdateItem(index, 'carats', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Rate / Carat (USD)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={item.ratePerCarat}
                        onChange={(e) => handleUpdateItem(index, 'ratePerCarat', e.target.value)}
                        className="w-full px-2 py-1 text-xs border border-slate-300 rounded focus:border-blue-500 focus:outline-none bg-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Total Amount (USD)</label>
                      <div className="px-2 py-1 text-xs border border-slate-200 rounded bg-slate-100 font-mono font-bold text-slate-900">
                        ${item.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Freight & Insurance Adjustments */}
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50 space-y-2">
              <h4 className="text-xs font-semibold text-slate-800">Export Freight & Valuation</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Armoured Freight (USD)</label>
                  <input
                    type="number"
                    step="1"
                    value={invoice.freightUsd}
                    onChange={(e) => onChange({ ...invoice, freightUsd: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Transit Insurance (USD)</label>
                  <input
                    type="number"
                    step="1"
                    value={invoice.insuranceUsd}
                    onChange={(e) => onChange({ ...invoice, insuranceUsd: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Customs INR Rate (USD/INR)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={invoice.exchangeRateInr}
                    onChange={(e) => onChange({ ...invoice, exchangeRateInr: parseFloat(e.target.value) || 86.65 })}
                    className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white font-mono font-bold"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PARTIES TAB */}
        {activeTab === 'parties' && (
          <div className="space-y-5 text-xs">
            {/* Exporter Section */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
                <Building2 className="w-4 h-4 text-blue-600" />
                <h3 className="font-semibold text-slate-900">Indian Exporter (Shipper)</h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Company Name</label>
                  <input
                    type="text"
                    value={invoice.exporter.companyName}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, companyName: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-semibold text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Address Line 1</label>
                  <input
                    type="text"
                    value={invoice.exporter.addressLine1}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, addressLine1: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Address Line 2 (Facility/Tower)</label>
                  <input
                    type="text"
                    value={invoice.exporter.addressLine2}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, addressLine2: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">City & State</label>
                  <input
                    type="text"
                    value={`${invoice.exporter.city}, ${invoice.exporter.state}`}
                    onChange={(e) => {
                      const parts = e.target.value.split(',');
                      onChange({
                        ...invoice,
                        exporter: {
                          ...invoice.exporter,
                          city: parts[0]?.trim() || '',
                          state: parts[1]?.trim() || invoice.exporter.state,
                        },
                      });
                    }}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">State Code & PIN</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="State Code (e.g. 24)"
                      value={invoice.exporter.stateCode}
                      onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, stateCode: e.target.value } })}
                      className="w-1/3 px-2 py-1 border border-slate-300 rounded font-mono"
                    />
                    <input
                      type="text"
                      placeholder="PIN Code"
                      value={invoice.exporter.pincode}
                      onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, pincode: e.target.value } })}
                      className="w-2/3 px-2 py-1 border border-slate-300 rounded font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Tax & Compliance IDs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 font-mono">
                <div>
                  <label className="block text-[10px] font-sans font-medium text-slate-600 mb-0.5">IEC (Import Export)</label>
                  <input
                    type="text"
                    value={invoice.exporter.iec}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, iec: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans font-medium text-slate-600 mb-0.5">GSTIN</label>
                  <input
                    type="text"
                    value={invoice.exporter.gstin}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, gstin: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans font-medium text-slate-600 mb-0.5">PAN</label>
                  <input
                    type="text"
                    value={invoice.exporter.pan}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, pan: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans font-medium text-slate-600 mb-0.5">GJEPC RCMC No.</label>
                  <input
                    type="text"
                    value={invoice.exporter.rcmcNo}
                    onChange={(e) => onChange({ ...invoice, exporter: { ...invoice.exporter, rcmcNo: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded text-blue-900 font-bold"
                  />
                </div>
              </div>
            </div>

            {/* Consignee Section */}
            <div className="space-y-3 pt-3 border-t border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
                <UserCheck className="w-4 h-4 text-emerald-600" />
                <h3 className="font-semibold text-slate-900">Overseas Consignee (Buyer)</h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Company Name</label>
                  <input
                    type="text"
                    value={invoice.consignee.companyName}
                    onChange={(e) => onChange({ ...invoice, consignee: { ...invoice.consignee, companyName: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-semibold text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Address</label>
                  <input
                    type="text"
                    value={invoice.consignee.addressLine1}
                    onChange={(e) => onChange({ ...invoice, consignee: { ...invoice.consignee, addressLine1: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">City & Country</label>
                  <input
                    type="text"
                    value={`${invoice.consignee.city}, ${invoice.consignee.country}`}
                    onChange={(e) => {
                      const parts = e.target.value.split(',');
                      onChange({
                        ...invoice,
                        consignee: {
                          ...invoice.consignee,
                          city: parts[0]?.trim() || '',
                          country: parts[1]?.trim() || invoice.consignee.country,
                        },
                      });
                    }}
                    className="w-full px-2 py-1 border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Overseas VAT / Tax ID</label>
                  <input
                    type="text"
                    value={invoice.consignee.taxIdVat}
                    onChange={(e) => onChange({ ...invoice, consignee: { ...invoice.consignee, taxIdVat: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Buyer Email & Contact Person</label>
                  <input
                    type="text"
                    value={invoice.consignee.email}
                    onChange={(e) => onChange({ ...invoice, consignee: { ...invoice.consignee, email: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SHIPPING & LOGISTICS TAB */}
        {activeTab === 'shipping' && (
          <div className="space-y-4 text-xs">
            <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
              <Plane className="w-4 h-4 text-blue-600" />
              <h3 className="font-semibold text-slate-900">Customs Ports, Carrier & Armoured Transport</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Invoice Number</label>
                <input
                  type="text"
                  value={invoice.shipment.invoiceNumber}
                  placeholder="Assigned automatically on save"
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, invoiceNumber: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Invoice Date</label>
                <input
                  type="date"
                  value={invoice.shipment.invoiceDate}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, invoiceDate: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Incoterms (2020)</label>
                <select
                  value={invoice.shipment.incoterms}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, incoterms: e.target.value as any } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded bg-white font-semibold"
                >
                  <option value="CIF">CIF (Cost, Insurance & Freight)</option>
                  <option value="FOB">FOB (Free On Board)</option>
                  <option value="C&F">C&F (Cost & Freight)</option>
                  <option value="DAP">DAP (Delivered at Place)</option>
                  <option value="EXW">EXW (Ex Works)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Incoterm Destination Location</label>
                <input
                  type="text"
                  value={invoice.shipment.incotermLocation}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, incotermLocation: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-medium"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Port of Loading</label>
                <input
                  type="text"
                  value={invoice.shipment.portOfLoading}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, portOfLoading: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-medium"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Port of Discharge / Destination</label>
                <input
                  type="text"
                  value={invoice.shipment.portOfDischarge}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, portOfDischarge: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-medium"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Armoured Carrier Name</label>
                <input
                  type="text"
                  value={invoice.shipment.carrierName}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, carrierName: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Air Waybill (AWB) No.</label>
                <input
                  type="text"
                  value={invoice.shipment.awbNumber}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, awbNumber: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold"
                />
              </div>
            </div>

            {/* Vault Box & Seal */}
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50 space-y-2">
              <h4 className="font-semibold text-slate-900">Armoured Vault Packaging & Seals</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div>
                  <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Tin Box No</label>
                  <input
                    type="text"
                    value={invoice.packing.vaultBoxNo}
                    onChange={(e) => onChange({ ...invoice, packing: { ...invoice.packing, vaultBoxNo: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Tamper Seal No</label>
                  <input
                    type="text"
                    value={invoice.packing.tamperSealNo}
                    onChange={(e) => onChange({ ...invoice, packing: { ...invoice.packing, tamperSealNo: e.target.value } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold text-blue-900 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Tare Weight (g)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={invoice.packing.tareWeightGrams}
                    onChange={(e) => onChange({ ...invoice, packing: { ...invoice.packing, tareWeightGrams: parseFloat(e.target.value) || 0 } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-slate-600 mb-0.5">Gross Weight (g)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={invoice.packing.grossWeightGrams}
                    onChange={(e) => onChange({ ...invoice, packing: { ...invoice.packing, grossWeightGrams: parseFloat(e.target.value) || 0 } })}
                    className="w-full px-2 py-1 border border-slate-300 rounded font-mono bg-white"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BANK & AD CODE TAB */}
        {activeTab === 'bank' && (
          <div className="space-y-4 text-xs">
            <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
              <CreditCard className="w-4 h-4 text-blue-600" />
              <h3 className="font-semibold text-slate-900">Customs 14-Digit AD Code & Bank Remittance</h3>
            </div>

            <div className="p-3 bg-blue-50/60 border border-blue-200 rounded-lg text-slate-700 text-[11px] leading-relaxed">
              <strong>Customs Compliance Requirement:</strong> The Authorized Dealer (AD) Code must match the registered port code in ICEGATE / EDPMS to ensure automatic issuance of e-BRC (Electronic Bank Realisation Certificate).
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Bank Name</label>
                <input
                  type="text"
                  value={invoice.bank.bankName}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, bankName: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-semibold text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Branch</label>
                <input
                  type="text"
                  value={invoice.bank.branch}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, branch: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Customs 14-Digit AD Code</label>
                <input
                  type="text"
                  value={invoice.bank.adCode}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, adCode: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold text-blue-900"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Account Number</label>
                <input
                  type="text"
                  value={invoice.bank.accountNumber}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, accountNumber: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono font-bold"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">SWIFT / BIC Code</label>
                <input
                  type="text"
                  value={invoice.bank.swiftCode}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, swiftCode: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">IFSC Code</label>
                <input
                  type="text"
                  value={invoice.bank.ifscCode}
                  onChange={(e) => onChange({ ...invoice, bank: { ...invoice.bank, ifscCode: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </div>
            </div>
          </div>
        )}

        {/* CLAUSES & DECLARATIONS TAB */}
        {activeTab === 'clauses' && (
          <div className="space-y-4 text-xs">
            <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
              <ShieldAlert className="w-4 h-4 text-emerald-600" />
              <h3 className="font-semibold text-slate-900">Kimberley Process, Natural Diamond & LUT Declarations</h3>
            </div>

            <div className="space-y-3">
              <label className="flex items-start gap-2.5 p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={invoice.declarations.kimberleyClause}
                  onChange={(e) => onChange({
                    ...invoice,
                    declarations: { ...invoice.declarations, kimberleyClause: e.target.checked },
                  })}
                  className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="font-semibold text-slate-900 block">Kimberley Process Certification Scheme (KPCS) Clause</span>
                  <span className="text-[11px] text-slate-600 block mt-0.5 leading-normal">
                    Mandatory warranty guaranteeing conflict-free origin in compliance with UN resolutions and World Diamond Council System of Warranties.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={invoice.declarations.naturalDiamondAffirmation}
                  onChange={(e) => onChange({
                    ...invoice,
                    declarations: { ...invoice.declarations, naturalDiamondAffirmation: e.target.checked },
                  })}
                  className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="font-semibold text-slate-900 block">Natural Earth-Mined Affirmation (Anti-Lab Grown Exclusion)</span>
                  <span className="text-[11px] text-slate-600 block mt-0.5 leading-normal">
                    Solemn declaration affirming 100% natural earth-mined diamonds with strict exclusion of CVD/HPHT synthetics and simulated goods.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={invoice.declarations.lutSupplyClause}
                  onChange={(e) => onChange({
                    ...invoice,
                    declarations: { ...invoice.declarations, lutSupplyClause: e.target.checked },
                  })}
                  className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <span className="font-semibold text-slate-900 block">GST Letter of Undertaking (LUT) Zero-Rated Clause</span>
                  <span className="text-[11px] text-slate-600 block mt-0.5 leading-normal">
                    Export of goods without payment of IGST under Rule 96A and Section 16(3) of the IGST Act, 2017.
                  </span>
                </div>
              </label>
            </div>

            {/* Reference Numbers */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">KPCS Certificate Reference</label>
                <input
                  type="text"
                  value={invoice.shipment.kpcsNumber}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, kpcsNumber: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">GST LUT ARN Number</label>
                <input
                  type="text"
                  value={invoice.shipment.lutNumber}
                  onChange={(e) => onChange({ ...invoice, shipment: { ...invoice.shipment, lutNumber: e.target.value } })}
                  className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Authorized Signatory Name</label>
                <input
                  type="text"
                  value={invoice.authorizedSignatoryName}
                  onChange={(e) => onChange({ ...invoice, authorizedSignatoryName: e.target.value })}
                  className="w-full px-2 py-1 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Signatory Designation</label>
                <input
                  type="text"
                  value={invoice.authorizedSignatoryDesignation}
                  onChange={(e) => onChange({ ...invoice, authorizedSignatoryDesignation: e.target.value })}
                  className="w-full px-2 py-1 border border-slate-300 rounded"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
