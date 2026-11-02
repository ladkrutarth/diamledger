import React, { useState } from 'react';
import { 
  Download, 
  Printer, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  CheckCircle2, 
  ShieldCheck, 
  FileText, 
  Package, 
  Stamp,
  ExternalLink
} from 'lucide-react';
import { InvoiceState } from '../../types/invoice';
import { numberToWordsUSD } from '../../utils/numberToWords';
import { exportElementToPdf } from '../../utils/pdfGenerator';

interface Props {
  invoice: InvoiceState;
  onUpdateInvoice?: (updated: InvoiceState) => void;
}

export const A1005InvoicePreview: React.FC<Props> = ({ invoice }) => {
  const [docType, setDocType] = useState<'invoice' | 'packing_list'>('invoice');
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [showOfficialStamp, setShowOfficialStamp] = useState<boolean>(true);
  const [watermarkType, setWatermarkType] = useState<'ORIGINAL' | 'DUPLICATE' | 'TRIPLICATE'>('ORIGINAL');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Totals calculations
  const totalCarats = invoice.items.reduce((sum, item) => sum + (Number(item.carats) || 0), 0);
  const totalPieces = invoice.items.reduce((sum, item) => sum + (Number(item.pieces) || 0), 0);
  const itemsTotalUSD = invoice.items.reduce((sum, item) => sum + (Number(item.totalAmount) || 0), 0);
  const totalCifUSD = itemsTotalUSD + (Number(invoice.freightUsd) || 0) + (Number(invoice.insuranceUsd) || 0) + (Number(invoice.otherChargesUsd) || 0);
  const totalINR = totalCifUSD * (invoice.exchangeRateInr || 86.65);

  const handleDownloadPdf = async () => {
    setIsExporting(true);
    try {
      const filename = `${docType === 'invoice' ? 'COMMERCIAL_INVOICE' : 'PACKING_LIST'}_${invoice.shipment.invoiceNumber.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`;
      await exportElementToPdf('a1005-printable-document', {
        filename,
        download: true,
      });
    } catch (err) {
      console.error('PDF generation error:', err);
      // Fallback to print
      window.print();
    } finally {
      setIsExporting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="flex flex-col h-full bg-slate-100 text-slate-800">
      {/* Top Document Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2">
          {/* Doc Type Selector */}
          <div className="flex items-center p-0.5 bg-slate-100 rounded-lg text-xs font-medium">
            <button
              onClick={() => setDocType('invoice')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                docType === 'invoice'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5 text-blue-600" />
              <span>Commercial Invoice</span>
            </button>
            <button
              onClick={() => setDocType('packing_list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
                docType === 'packing_list'
                  ? 'bg-white text-slate-900 shadow-xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Package className="w-3.5 h-3.5 text-emerald-600" />
              <span>Export Packing List</span>
            </button>
          </div>

          {/* Copy designation */}
          <select
            value={watermarkType}
            onChange={(e) => setWatermarkType(e.target.value as any)}
            className="text-xs bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="ORIGINAL">ORIGINAL FOR CUSTOMS / BUYER</option>
            <option value="DUPLICATE">DUPLICATE FOR BANK / DGFT</option>
            <option value="TRIPLICATE">TRIPLICATE FOR CARRIER / CHA</option>
          </select>
        </div>

        {/* Viewport & Action Controls */}
        <div className="flex items-center gap-2">
          {/* Stamp toggle */}
          <button
            onClick={() => setShowOfficialStamp(!showOfficialStamp)}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
              showOfficialStamp 
                ? 'bg-blue-50 border-blue-200 text-blue-700' 
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
            title="Toggle official customs seal and signature stamp"
          >
            <Stamp className="w-3.5 h-3.5" />
            <span>{showOfficialStamp ? 'Seal Active' : 'No Seal'}</span>
          </button>

          {/* Zoom controls */}
          <div className="flex items-center bg-slate-50 border border-slate-200 rounded-md">
            <button
              onClick={() => setZoomLevel((prev) => Math.max(prev - 10, 60))}
              className="p-1.5 text-slate-600 hover:text-slate-900"
              title="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono px-1.5 text-slate-700 min-w-10 text-center">
              {zoomLevel}%
            </span>
            <button
              onClick={() => setZoomLevel((prev) => Math.min(prev + 10, 140))}
              className="p-1.5 text-slate-600 hover:text-slate-900"
              title="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setZoomLevel(100)}
              className="p-1.5 text-slate-400 hover:text-slate-700 border-l border-slate-200"
              title="Reset 100%"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>

          {/* Print button */}
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print</span>
          </button>

          {/* PDF Download */}
          <button
            onClick={handleDownloadPdf}
            disabled={isExporting}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Generating PDF...' : 'Download PDF'}</span>
          </button>
        </div>
      </div>

      {/* Main Document Viewport with scroll and zoom */}
      <div className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 flex justify-center items-start">
        <div 
          style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top center' }}
          className="transition-transform duration-150"
        >
          {/* Strict A4 Printable Container (210mm x 297mm equivalent: ~794px width) */}
          <div
            id="a1005-printable-document"
            className="w-[794px] min-h-[1123px] bg-white text-slate-950 p-7 shadow-xl border border-slate-300 relative text-[10px] leading-tight font-sans box-border"
          >
            {/* Header Title Bar */}
            <div className="border-b-2 border-slate-900 pb-2 mb-2 flex justify-between items-start">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-950 font-serif uppercase">
                  {docType === 'invoice' ? 'COMMERCIAL INVOICE' : 'EXPORT PACKING LIST'}
                </h1>
                <p className="text-[10px] font-medium text-slate-600 tracking-wider uppercase">
                  FOR EXPORT OF CUT & POLISHED NATURAL DIAMONDS (A1005 COMPLIANCE STANDARD)
                </p>
              </div>
              <div className="text-right">
                <span className="inline-block border border-slate-800 px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase bg-slate-50">
                  {watermarkType} FOR CUSTOMS
                </span>
                <p className="text-[9px] text-slate-500 mt-0.5">
                  GJEPC RCMC: <span className="font-mono font-bold text-slate-900">{invoice.exporter.rcmcNo}</span>
                </p>
              </div>
            </div>

            {/* Grid 1: Exporter vs Invoice Meta Table */}
            <div className="border border-slate-800 grid grid-cols-2 divide-x divide-slate-800 mb-2">
              {/* Left Column: Exporter Info */}
              <div className="p-2 space-y-1">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                  Exporter / Shipper:
                </div>
                <div className="font-bold text-xs text-slate-950 leading-snug">
                  {invoice.exporter.companyName}
                </div>
                <div className="text-slate-700 leading-normal">
                  {invoice.exporter.addressLine1},<br />
                  {invoice.exporter.addressLine2},<br />
                  {invoice.exporter.city} - {invoice.exporter.pincode}, {invoice.exporter.state}, {invoice.exporter.country}
                </div>
                <div className="pt-1 text-[9px] font-mono grid grid-cols-2 gap-x-2 text-slate-900">
                  <div>IEC: <span className="font-bold">{invoice.exporter.iec}</span></div>
                  <div>GSTIN: <span className="font-bold">{invoice.exporter.gstin}</span></div>
                  <div>PAN: <span className="font-bold">{invoice.exporter.pan}</span></div>
                  <div>STATE CODE: <span className="font-bold">{invoice.exporter.stateCode} ({invoice.exporter.state})</span></div>
                </div>
              </div>

              {/* Right Column: Invoice Reference Grid */}
              <div className="text-[9px]">
                <div className="grid grid-cols-2 border-b border-slate-800 divide-x divide-slate-800">
                  <div className="p-1.5">
                    <span className="text-slate-500 block uppercase font-medium">Invoice No. & Date:</span>
                    <span className="font-mono font-bold text-slate-950 text-[10px]">{invoice.shipment.invoiceNumber}</span>
                    <span className="block text-slate-700 font-mono">Date: {invoice.shipment.invoiceDate}</span>
                  </div>
                  <div className="p-1.5">
                    <span className="text-slate-500 block uppercase font-medium">Exporter's Ref / Order No:</span>
                    <span className="font-mono font-bold text-slate-950">{invoice.shipment.exporterRef}</span>
                    <span className="block text-slate-700 font-mono">PO: {invoice.shipment.buyerOrderRef}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 border-b border-slate-800 divide-x divide-slate-800">
                  <div className="p-1.5">
                    <span className="text-slate-500 block uppercase font-medium">Kimberley Process (KPCS) Ref:</span>
                    <span className="font-mono font-bold text-slate-900">{invoice.shipment.kpcsNumber}</span>
                  </div>
                  <div className="p-1.5">
                    <span className="text-slate-500 block uppercase font-medium">GST Supply LUT No (Zero-Rated):</span>
                    <span className="font-mono font-bold text-slate-900">{invoice.shipment.lutNumber}</span>
                  </div>
                </div>

                <div className="p-1.5">
                  <span className="text-slate-500 block uppercase font-medium">Terms of Delivery & Payment (Incoterms 2020):</span>
                  <span className="font-bold text-slate-900">{invoice.shipment.incoterms} {invoice.shipment.incotermLocation}</span>
                  <span className="block text-slate-700">{invoice.shipment.paymentTerms}</span>
                </div>
              </div>
            </div>

            {/* Grid 2: Consignee & Buyer */}
            <div className="border border-slate-800 grid grid-cols-2 divide-x divide-slate-800 mb-2">
              <div className="p-2 space-y-0.5">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                  Consignee:
                </div>
                <div className="font-bold text-xs text-slate-950 leading-snug">
                  {invoice.consignee.companyName}
                </div>
                <div className="text-slate-700 leading-normal">
                  {invoice.consignee.addressLine1}, {invoice.consignee.addressLine2}<br />
                  {invoice.consignee.city}, {invoice.consignee.state} - {invoice.consignee.postalCode}, {invoice.consignee.country}
                </div>
                <div className="text-[9px] font-mono text-slate-800 pt-0.5">
                  TAX ID / VAT: <span className="font-bold">{invoice.consignee.taxIdVat}</span>
                  {invoice.consignee.contactPerson && (
                    <span className="block text-slate-600 font-sans">Attn: {invoice.consignee.contactPerson}</span>
                  )}
                </div>
              </div>

              <div className="p-2 space-y-0.5">
                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                  Buyer (If other than Consignee):
                </div>
                {invoice.consignee.buyerOtherThanConsignee ? (
                  <>
                    <div className="font-bold text-slate-950">{invoice.consignee.buyerName}</div>
                    <div className="text-slate-700">{invoice.consignee.buyerAddress}, {invoice.consignee.buyerCountry}</div>
                    <div className="text-[9px] font-mono text-slate-800">TAX ID: {invoice.consignee.buyerTaxId}</div>
                  </>
                ) : (
                  <div className="italic text-slate-500 text-[10px] pt-1">
                    SAME AS CONSIGNEE (Direct Consignment Under Customs Sealed Baggage)
                  </div>
                )}
                
                {/* Vault & Box Seal info */}
                <div className="mt-2 pt-2 border-t border-dashed border-slate-300 text-[9px] font-mono text-slate-800">
                  <div>VAULT TIN BOX NO: <span className="font-bold">{invoice.packing.vaultBoxNo}</span></div>
                  <div>SECURITY SEAL NO: <span className="font-bold text-blue-900">{invoice.packing.tamperSealNo}</span></div>
                </div>
              </div>
            </div>

            {/* Grid 3: Shipping & Logistics Details */}
            <div className="border border-slate-800 grid grid-cols-4 divide-x divide-slate-800 mb-2 text-[9px]">
              <div className="p-1.5">
                <span className="text-slate-500 block uppercase font-medium">Pre-Carriage / Carrier:</span>
                <span className="font-bold text-slate-900">{invoice.shipment.carrierName}</span>
                <span className="block text-slate-600">Flight: {invoice.shipment.flightNumber}</span>
              </div>
              <div className="p-1.5">
                <span className="text-slate-500 block uppercase font-medium">Air Waybill (AWB) No:</span>
                <span className="font-mono font-bold text-slate-900 text-[10px]">{invoice.shipment.awbNumber}</span>
                <span className="block text-slate-600">Insurance: {invoice.shipment.insurancePolicyNo || 'Covered by Shipper'}</span>
              </div>
              <div className="p-1.5">
                <span className="text-slate-500 block uppercase font-medium">Port of Loading:</span>
                <span className="font-bold text-slate-900">{invoice.shipment.portOfLoading}</span>
                <span className="block text-slate-600">Origin: <strong className="text-slate-950">{invoice.shipment.countryOfOrigin}</strong></span>
              </div>
              <div className="p-1.5">
                <span className="text-slate-500 block uppercase font-medium">Port of Discharge:</span>
                <span className="font-bold text-slate-900">{invoice.shipment.portOfDischarge}</span>
                <span className="block text-slate-600">Final: <strong className="text-slate-950">{invoice.shipment.countryOfDestination}</strong></span>
              </div>
            </div>

            {/* Grid 4: Diamond Line Items Table */}
            <div className="border border-slate-800 mb-2">
              <table className="w-full border-collapse text-left text-[9px]">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-800 text-slate-900 font-bold uppercase tracking-wider">
                    <th className="py-1.5 px-2 border-r border-slate-800 w-7 text-center">Sr</th>
                    <th className="py-1.5 px-2 border-r border-slate-800">Description of Goods</th>
                    <th className="py-1.5 px-2 border-r border-slate-800 w-16 text-center">HS Code</th>
                    <th className="py-1.5 px-2 border-r border-slate-800 w-24">Lab Report / Cert</th>
                    <th className="py-1.5 px-2 border-r border-slate-800 w-16 text-center">Lot / Parcel</th>
                    <th className="py-1.5 px-2 border-r border-slate-800 w-10 text-right">Pcs</th>
                    <th className="py-1.5 px-2 border-r border-slate-800 w-16 text-right">Carats (cts)</th>
                    {docType === 'invoice' && (
                      <>
                        <th className="py-1.5 px-2 border-r border-slate-800 w-20 text-right">Rate / ct (USD)</th>
                        <th className="py-1.5 px-2 text-right w-24">Total (USD)</th>
                      </>
                    )}
                    {docType === 'packing_list' && (
                      <>
                        <th className="py-1.5 px-2 border-r border-slate-800 w-20 text-right">Net Wt (Grams)</th>
                        <th className="py-1.5 px-2 text-right w-24">Packaging Status</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-300">
                  {invoice.items.map((item, idx) => {
                    const grams = (item.carats * 0.2).toFixed(3);
                    return (
                      <tr key={item.id || idx} className="hover:bg-slate-50/50">
                        <td className="py-1.5 px-2 border-r border-slate-800 text-center font-mono text-slate-600">
                          {idx + 1}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800">
                          <div className="font-bold text-slate-950">{item.description}</div>
                          {(item.shape || item.colorClarity) && (
                            <div className="text-[8px] text-slate-600">
                              {item.shape && <span>Shape: {item.shape} · </span>}
                              {item.colorClarity && <span>Color/Clarity: {item.colorClarity} · </span>}
                              {item.cutGrade && <span>Cut: {item.cutGrade}</span>}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-center font-mono text-slate-800">
                          {item.hsCode}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 font-mono text-[8.5px] text-slate-800">
                          {item.certificateNo || 'SELF CERTIFIED'}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-center font-mono text-slate-700">
                          {item.parcelId || `LOT-${idx + 1}`}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono tabular-nums text-slate-900">
                          {item.pieces}
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono font-bold tabular-nums text-slate-950">
                          {item.carats.toFixed(3)}
                        </td>
                        {docType === 'invoice' && (
                          <>
                            <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono tabular-nums text-slate-900">
                              ${item.ratePerCarat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono font-bold tabular-nums text-slate-950">
                              ${item.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </>
                        )}
                        {docType === 'packing_list' && (
                          <>
                            <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono tabular-nums text-slate-900">
                              {grams} g
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-[8px] text-emerald-800 font-semibold">
                              VAULT SEALED
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>

                {/* Subtotals & Grand Totals */}
                <tfoot>
                  <tr className="bg-slate-100 border-t-2 border-slate-800 font-bold">
                    <td colSpan={5} className="py-1.5 px-2 border-r border-slate-800 text-right uppercase text-[9px]">
                      TOTAL QUANTITY & MERCHANDISE CARATS:
                    </td>
                    <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono tabular-nums text-slate-950">
                      {totalPieces} pcs
                    </td>
                    <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono font-bold tabular-nums text-slate-950 text-[10px]">
                      {totalCarats.toFixed(3)} cts
                    </td>
                    {docType === 'invoice' && (
                      <>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-right uppercase text-[8px] text-slate-600">
                          FOB SUB-TOTAL:
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-bold tabular-nums text-slate-950">
                          ${itemsTotalUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </>
                    )}
                    {docType === 'packing_list' && (
                      <>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono tabular-nums text-slate-950">
                          {(totalCarats * 0.2).toFixed(3)} g
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[8px] text-slate-700">
                          PKGS: {invoice.packing.numberOfPackages}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Freight & Insurance Breakdown for Invoice */}
                  {docType === 'invoice' && (
                    <>
                      {invoice.freightUsd > 0 && (
                        <tr className="text-slate-800 border-t border-slate-300">
                          <td colSpan={7} className="py-1 px-2 border-r border-slate-800 text-right text-[8.5px]">
                            Add: Armoured Air Freight ({invoice.shipment.carrierName}):
                          </td>
                          <td className="py-1 px-2 border-r border-slate-800 text-right font-mono text-[8.5px]">USD</td>
                          <td className="py-1 px-2 text-right font-mono tabular-nums text-[8.5px]">
                            ${invoice.freightUsd.toFixed(2)}
                          </td>
                        </tr>
                      )}
                      {invoice.insuranceUsd > 0 && (
                        <tr className="text-slate-800 border-t border-slate-300">
                          <td colSpan={7} className="py-1 px-2 border-r border-slate-800 text-right text-[8.5px]">
                            Add: Transit Marine Risk Insurance ({invoice.shipment.insurancePolicyNo || 'All-Risks'}):
                          </td>
                          <td className="py-1 px-2 border-r border-slate-800 text-right font-mono text-[8.5px]">USD</td>
                          <td className="py-1 px-2 text-right font-mono tabular-nums text-[8.5px]">
                            ${invoice.insuranceUsd.toFixed(2)}
                          </td>
                        </tr>
                      )}
                      <tr className="bg-slate-200/70 border-t-2 border-slate-800 font-bold text-[10px]">
                        <td colSpan={7} className="py-1.5 px-2 border-r border-slate-800 text-right uppercase tracking-wider text-slate-950">
                          TOTAL {invoice.shipment.incoterms} VALUE (USD):
                        </td>
                        <td className="py-1.5 px-2 border-r border-slate-800 text-right font-mono text-slate-900">
                          USD
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-bold tabular-nums text-slate-950 text-xs">
                          ${totalCifUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    </>
                  )}

                  {/* Packing List Weight Specification */}
                  {docType === 'packing_list' && (
                    <tr className="bg-slate-50 border-t border-slate-800 text-[9px] text-slate-800">
                      <td colSpan={9} className="py-2 px-3 space-y-1">
                        <div className="font-bold text-slate-950 uppercase">PACKAGING SPECIFICATIONS & GROSS WEIGHT:</div>
                        <div className="grid grid-cols-4 gap-2 font-mono text-[8.5px]">
                          <div>Net Diamond Weight: <strong>{totalCarats.toFixed(3)} cts ({(totalCarats * 0.2).toFixed(3)} g)</strong></div>
                          <div>Tare Box Weight: <strong>{invoice.packing.tareWeightGrams.toFixed(2)} g</strong></div>
                          <div>Gross Package Weight: <strong>{invoice.packing.grossWeightGrams.toFixed(2)} g</strong></div>
                          <div>Package Dimensions: <strong>{invoice.packing.packageDimensions}</strong></div>
                        </div>
                        <div className="text-[8px] text-slate-600 italic">
                          Diamonds packed in individual folded diamond papers, secured in welded aluminum tin canister, placed in tamper-evident armored courier vault pouch.
                        </div>
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>

            {/* Total Amount in Words */}
            {docType === 'invoice' && (
              <div className="border border-slate-800 p-2 mb-2 bg-slate-50/70 text-[9px]">
                <span className="font-bold text-slate-500 uppercase block tracking-wider">Amount Chargeable in Words (USD):</span>
                <span className="font-bold text-slate-950 font-serif text-[10px]">
                  {numberToWordsUSD(totalCifUSD)}
                </span>
                <div className="text-[8px] text-slate-600 mt-0.5 font-mono">
                  Conversion for Indian Customs Valuation: 1 USD = INR {invoice.exchangeRateInr.toFixed(2)} · Equivalent INR: ₹{totalINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
            )}

            {/* Statutory Declarations & GJEPC Clauses */}
            <div className="border border-slate-800 p-2 mb-2 text-[8.5px] leading-relaxed space-y-1 text-slate-800">
              <div className="font-bold text-slate-950 uppercase tracking-wider text-[9px] border-b border-slate-300 pb-0.5 flex items-center justify-between">
                <span>Statutory Declarations & International Diamond Compliance</span>
                <span className="text-[8px] font-mono text-emerald-700 flex items-center gap-1 font-semibold">
                  <ShieldCheck className="w-3 h-3 text-emerald-600" />
                  KPCS & GJEPC VERIFIED
                </span>
              </div>

              {invoice.declarations.kimberleyClause && (
                <div>
                  <strong>1. Kimberley Process Certification Scheme (KPCS):</strong> "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict and in compliance with United Nations Resolutions and the Kimberley Process Certification Scheme. The seller hereby guarantees that these diamonds are conflict free, based on personal knowledge and/or written guarantees provided by the supplier of these diamonds."
                </div>
              )}

              {invoice.declarations.naturalDiamondAffirmation && (
                <div>
                  <strong>2. Natural Diamond Affirmation:</strong> "We solemnly declare that the diamonds invoiced herein are 100% Natural Earth-Mined Cut & Polished Diamonds and are NOT Synthetic / Lab-Grown / CVD / HPHT or Simulants, and have not been subjected to fracture filling or clarity/color treatments."
                </div>
              )}

              {invoice.declarations.gjepcOriginClause && (
                <div>
                  <strong>3. Country of Origin & GJEPC:</strong> "We declare that the goods invoiced are of Indian Origin, manufactured in India under valid GJEPC Membership RCMC No: {invoice.exporter.rcmcNo}, from rough diamonds imported under valid Kimberley Process Certificate."
                </div>
              )}

              {invoice.declarations.lutSupplyClause && (
                <div>
                  <strong>4. GST Letter of Undertaking (LUT):</strong> "Supply meant for export under Letter of Undertaking (LUT ARN: {invoice.shipment.lutNumber}) without payment of Integrated Goods & Services Tax (IGST) in accordance with Section 16(3) of the IGST Act, 2017."
                </div>
              )}
            </div>

            {/* Bank AD Code & Signatory Section */}
            <div className="border border-slate-800 grid grid-cols-2 divide-x divide-slate-800 text-[9px]">
              {/* Bank Details */}
              <div className="p-2 space-y-1">
                <div className="font-bold text-slate-900 uppercase tracking-wider text-[8.5px]">
                  Bank Remittance & Indian Customs AD Code:
                </div>
                <div className="font-bold text-slate-950">{invoice.bank.bankName}</div>
                <div className="text-slate-700">{invoice.bank.branch}</div>
                <div className="font-mono text-[8.5px] space-y-0.5 text-slate-900">
                  <div>Account No: <strong className="font-bold">{invoice.bank.accountNumber}</strong></div>
                  <div>14-Digit AD Code: <strong className="font-bold text-blue-900">{invoice.bank.adCode}</strong></div>
                  <div>SWIFT Code: <strong>{invoice.bank.swiftCode}</strong> · IFSC: <strong>{invoice.bank.ifscCode}</strong></div>
                  {invoice.bank.iban && <div>IBAN: <strong>{invoice.bank.iban}</strong></div>}
                  {invoice.bank.correspondentBank && (
                    <div className="text-[7.5px] text-slate-600">
                      Correspondent: {invoice.bank.correspondentBank} ({invoice.bank.correspondentSwift})
                    </div>
                  )}
                </div>
              </div>

              {/* Authorized Signatory Block */}
              <div className="p-2 flex flex-col justify-between relative">
                <div>
                  <div className="font-bold text-slate-900 uppercase text-[8.5px]">
                    For {invoice.exporter.companyName}:
                  </div>
                  <div className="text-[7.5px] text-slate-500 italic mt-0.5">
                    Authorized Signatory (Customs Clearance & GJEPC Trade)
                  </div>
                </div>

                {/* Digital Stamp Overlay */}
                {showOfficialStamp && (
                  <div className="my-1 flex items-center justify-center">
                    <div className="border-2 border-blue-900/80 rounded-md p-1.5 text-center text-blue-900/90 transform -rotate-2 bg-blue-50/40">
                      <div className="text-[8px] font-bold tracking-widest uppercase">
                        {invoice.exporter.companyName}
                      </div>
                      <div className="text-[7px] font-mono">
                        CUSTOMS & GJEPC EXPORT DESK
                      </div>
                      <div className="text-[9px] font-serif italic text-blue-950 font-bold my-0.5">
                        {invoice.authorizedSignatoryName}
                      </div>
                      <div className="text-[6.5px] tracking-wider uppercase text-blue-800">
                        VERIFIED · CONFLICT-FREE · KPCS MATCHED
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-slate-300">
                  <div className="font-bold text-slate-950">{invoice.authorizedSignatoryName}</div>
                  <div className="text-[8px] text-slate-600">{invoice.authorizedSignatoryDesignation}</div>
                  <div className="text-[7px] text-slate-500">Date: {invoice.shipment.invoiceDate}</div>
                </div>
              </div>
            </div>

            {/* Footer Notice */}
            <div className="text-[7.5px] text-center text-slate-400 mt-2">
              Prepared with Meridian · Compliant with GJEPC guidelines, RBI FEMA, and the Kimberley Process.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
