import React, { useState } from 'react';
import { 
  Sparkles, 
  Upload, 
  FileText, 
  Image as ImageIcon, 
  CheckCircle, 
  AlertCircle, 
  ArrowRight, 
  RefreshCw,
  X
} from 'lucide-react';
import { DiamondItem } from '../../types/invoice';

interface Props {
  onApplyParsedData: (data: { items: DiamondItem[]; notes?: string; consigneeName?: string; portOfDestination?: string; kpcsNumber?: string }, mode: 'replace' | 'append') => void;
  onClose: () => void;
}

const SAMPLE_MANIFEST_1 = `PARCEL MANIFEST REF: SRT/EXP/2026/LOT-491
ORIGIN: Surat Diamond Bourse, India
CONSIGNEE: Antwerp Diamond House BVBA, Belgium
DESTINATION: Antwerp (ANR)
KPCS REF: IN-GJ-2026-KPCS-009118

ITEMIZED LOT DETAILS:
1. Cut & Polished Natural Diamond - Round Brilliant, 1.52 cts, Color D, Clarity VVS1, 3EX, GIA Cert #2491028491, Lot #SRT-RD-01, Rate: $5,200/ct
2. Cut & Polished Natural Diamond - Round Brilliant, 2.04 cts, Color E, Clarity VVS2, 3EX, GIA Cert #7781920491, Lot #SRT-RD-02, Rate: $6,800/ct
3. Cut & Polished Natural Diamond - Emerald Cut Solitaire, 3.10 cts, Color F, Clarity VS1, EX, GIA Cert #1192849102, Lot #SRT-EM-03, Rate: $4,950/ct
4. Cut & Polished Natural Diamond - Princess Cut Solitaires, 5 pcs, Total 6.25 cts, Color G, Clarity VS2, Lot #SRT-PR-04, Rate: $2,800/ct
5. Natural Polished Diamond Melee (+14 to +18 sieve), 120 pcs, Total 2.40 cts, Color F-G, Clarity VS, Lot #SRT-ML-05, Rate: $750/ct`;

const SAMPLE_MANIFEST_2 = `BDB EXPORT DESK - PARCEL RECEIPT #BDB-NY-882
Shipper: Bharat Diamond Bourse, BKC, Mumbai
Buyer: Fifth Avenue Diamonds Inc, New York, USA
Delivery: JFK New York (CIF)

1. Oval Brilliant Natural Earth Mined Diamond, 1.85 cts, GIA #5218903341, Lot #NY-OV-1, Rate $4,200/ct
2. Pear Brilliant Natural Earth Mined Diamond, 2.45 cts, IGI #5982143091, Lot #NY-PR-2, Rate $3,900/ct
3. Radiant Cut Natural Diamond, 1.20 cts, GIA #3381904221, Lot #NY-RD-3, Rate $3,400/ct`;

export const AiManifestParser: React.FC<Props> = ({ onApplyParsedData, onClose }) => {
  const [manifestText, setManifestText] = useState<string>('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('image/jpeg');
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [parsedResult, setParsedResult] = useState<any | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        setImagePreview(reader.result as string);
        setMimeType(file.type);
      };
      reader.readAsDataURL(file);
    } else {
      // Text or CSV file
      const reader = new FileReader();
      reader.onload = () => {
        setManifestText(reader.result as string);
      };
      reader.readAsText(file);
    }
  };

  const handleParse = async () => {
    if (!manifestText.trim() && !imagePreview) {
      setErrorMessage('Please paste manifest text or upload a parcel slip document/image.');
      return;
    }

    setIsParsing(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/parse-manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifestText: manifestText.trim() || undefined,
          imageBase64: imagePreview || undefined,
          mimeType,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to parse manifest');
      }

      setParsedResult(data.data);
    } catch (err: any) {
      console.error('Parse error:', err);
      setErrorMessage(err.message || 'Error communicating with AI parser service.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleApply = (mode: 'replace' | 'append') => {
    if (!parsedResult || !parsedResult.items) return;

    const formattedItems: DiamondItem[] = parsedResult.items.map((raw: any, idx: number) => {
      const carats = parseFloat(raw.carats) || 1.0;
      const rate = parseFloat(raw.ratePerCarat) || 2000;
      const totalAmount = Math.round(carats * rate * 100) / 100;

      return {
        id: `parsed-${Date.now()}-${idx}`,
        srNo: idx + 1,
        description: raw.description || 'Cut & Polished Natural Earth-Mined Diamonds',
        shape: raw.shape || '',
        colorClarity: raw.colorClarity || '',
        cutGrade: raw.cutGrade || 'EX',
        hsCode: raw.hsCode || '7102.39.10',
        certificateNo: raw.certificateNo || 'N/A',
        parcelId: raw.parcelId || `LOT-${idx + 1}`,
        pieces: parseInt(raw.pieces) || 1,
        carats,
        ratePerCarat: rate,
        totalAmount,
      };
    });

    onApplyParsedData(
      {
        items: formattedItems,
        notes: parsedResult.notes,
        consigneeName: parsedResult.consigneeName,
        portOfDestination: parsedResult.portOfDestination,
        kpcsNumber: parsedResult.kpcsNumber,
      },
      mode
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-100 text-indigo-700">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">AI Diamond Parcel Manifest Parser</h2>
              <p className="text-[11px] text-slate-500">
                Powered by Gemini 3.8 Flash · Extracts carats, rates, certificates, and lot IDs directly into invoice table
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-auto p-5 space-y-4 text-xs">
          {/* Quick Samples */}
          <div>
            <span className="font-semibold text-slate-700 text-xs block mb-1.5">
              1-Click Realistic Manifest Samples:
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setManifestText(SAMPLE_MANIFEST_1);
                  setImagePreview(null);
                }}
                className="px-2.5 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 font-medium text-slate-700 transition-colors"
              >
                Surat SDB Certified Lot (5 Items)
              </button>
              <button
                onClick={() => {
                  setManifestText(SAMPLE_MANIFEST_2);
                  setImagePreview(null);
                }}
                className="px-2.5 py-1 rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 font-medium text-slate-700 transition-colors"
              >
                Mumbai BDB Solitaire Export Parcel (3 Items)
              </button>
            </div>
          </div>

          {/* Input Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Text / CSV Area */}
            <div className="space-y-1.5">
              <label className="font-medium text-slate-700 block">
                Paste Parcel Manifest, Grading Sheet, or Rough-to-Polished CSV:
              </label>
              <textarea
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                placeholder="Paste lot descriptions, carats, GIA report numbers, price/ct, or raw trade slips..."
                rows={9}
                className="w-full p-2.5 border border-slate-300 rounded-lg focus:border-indigo-500 focus:outline-none font-mono text-xs leading-relaxed"
              />
            </div>

            {/* Document / Image Upload */}
            <div className="space-y-1.5 flex flex-col">
              <label className="font-medium text-slate-700 block">
                Or Upload Document / Parcel Slip Photo:
              </label>
              <div className="flex-1 border-2 border-dashed border-slate-300 rounded-lg p-4 flex flex-col items-center justify-center text-center bg-slate-50 hover:bg-slate-100/50 transition-colors relative cursor-pointer">
                <input
                  type="file"
                  accept="image/*,.csv,.txt"
                  onChange={handleFileUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                {imagePreview ? (
                  <div className="space-y-2">
                    <img 
                      src={imagePreview} 
                      alt="Uploaded parcel manifest" 
                      className="max-h-32 object-contain mx-auto rounded border border-slate-200" 
                    />
                    <div className="text-[11px] text-emerald-700 font-medium flex items-center justify-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Image loaded ready for vision parsing
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1 text-slate-500">
                    <Upload className="w-6 h-6 mx-auto text-slate-400" />
                    <span className="font-semibold text-slate-700 block">Click to upload file</span>
                    <span className="text-[10px] text-slate-400 block">
                      Supports JPG, PNG parcel slips, or CSV grading sheets
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Error Notice */}
          {errorMessage && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Parse Button */}
          <div className="flex justify-end">
            <button
              onClick={handleParse}
              disabled={isParsing || (!manifestText.trim() && !imagePreview)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-xs transition-colors disabled:opacity-50"
            >
              {isParsing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Extracting Diamond Specifications...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Parse Manifest with Gemini 3.8</span>
                </>
              )}
            </button>
          </div>

          {/* Extracted Results Preview */}
          {parsedResult && parsedResult.items && (
            <div className="p-4 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-emerald-900 font-bold">
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <span>Successfully Extracted {parsedResult.items.length} Diamond Lots</span>
                </div>
                {parsedResult.consigneeName && (
                  <span className="text-[11px] text-emerald-800 font-mono">
                    Consignee: {parsedResult.consigneeName}
                  </span>
                )}
              </div>

              {/* Table of Parsed Items */}
              <div className="overflow-x-auto border border-emerald-300 rounded bg-white">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-emerald-100/70 border-b border-emerald-300 text-emerald-950 font-bold">
                    <tr>
                      <th className="p-1.5">Description</th>
                      <th className="p-1.5 text-center">HS Code</th>
                      <th className="p-1.5">Certificate</th>
                      <th className="p-1.5 text-right">Pcs</th>
                      <th className="p-1.5 text-right">Carats</th>
                      <th className="p-1.5 text-right">Rate/ct</th>
                      <th className="p-1.5 text-right">Total USD</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100 font-mono text-[10.5px]">
                    {parsedResult.items.map((item: any, idx: number) => {
                      const total = (parseFloat(item.carats) || 0) * (parseFloat(item.ratePerCarat) || 0);
                      return (
                        <tr key={idx} className="hover:bg-emerald-50/50">
                          <td className="p-1.5 font-sans font-medium text-slate-900">{item.description}</td>
                          <td className="p-1.5 text-center text-slate-700">{item.hsCode || '7102.39.10'}</td>
                          <td className="p-1.5 text-slate-800">{item.certificateNo || 'N/A'}</td>
                          <td className="p-1.5 text-right">{item.pieces || 1}</td>
                          <td className="p-1.5 text-right font-bold text-slate-950">{Number(item.carats).toFixed(3)}</td>
                          <td className="p-1.5 text-right">${Number(item.ratePerCarat).toFixed(2)}</td>
                          <td className="p-1.5 text-right font-bold text-emerald-950">${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Action Buttons to Merge */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  onClick={() => handleApply('append')}
                  className="px-3 py-1.5 rounded border border-emerald-300 bg-white hover:bg-emerald-50 text-emerald-900 font-semibold text-xs transition-colors"
                >
                  Append to Existing Items
                </button>
                <button
                  onClick={() => handleApply('replace')}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-xs transition-colors shadow-xs"
                >
                  <span>Replace Invoice Items</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
