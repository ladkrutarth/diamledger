import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, UserPlus, XCircle } from 'lucide-react';
import type { Buyer } from '../../../api/client';
import type { InvoiceState } from '../../../types/invoice';
import { LineItemsEditor } from './LineItemsEditor';
import { DeclarationField, EditorContext, NumberField, Section, SelectField, SubHeading, TextField } from './fields';
import { SECTIONS, invoiceTotals, issueCounts, type InvoiceIssue, type SectionKey } from './invoiceChecks';

const INCOTERMS: Array<[InvoiceState['shipment']['incoterms'], string]> = [
  ['CIF', 'CIF — cost, insurance, freight'],
  ['FOB', 'FOB — free on board'],
  ['C&F', 'C&F — cost and freight'],
  ['DAP', 'DAP — delivered at place'],
  ['EXW', 'EXW — ex works'],
];

const usd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Props = {
  invoice: InvoiceState;
  onChange: (next: InvoiceState) => void;
  issues: InvoiceIssue[];
  /** Show "missing" messages on every field, after the user has tried to issue. */
  showAll: boolean;
  locked: boolean;
  /** True once issued or cancelled: the summary then reports checks instead of readiness to issue. */
  issued?: boolean;
  buyers: Buyer[];
  onPickBuyer: (buyerId: string) => void;
  onSaveBuyer?: () => void;
  onReadManifest?: () => void;
};

const grid = 'grid grid-cols-1 gap-3 sm:grid-cols-2';

export const InvoiceEditor: React.FC<Props> = ({ invoice, onChange, issues, showAll, locked, issued = false, buyers, onPickBuyer, onSaveBuyer, onReadManifest }) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const counts = useMemo(() => issueCounts(issues), [issues]);
  const totals = useMemo(() => invoiceTotals(invoice), [invoice]);
  const byField = useMemo(() => {
    const map = new Map<string, InvoiceIssue[]>();
    for (const issue of issues) map.set(issue.field, [...(map.get(issue.field) ?? []), issue]);
    return map;
  }, [issues]);

  const set = <K extends keyof InvoiceState>(key: K, value: InvoiceState[K]) => onChange({ ...invoice, [key]: value });
  const exporter = (patch: Partial<InvoiceState['exporter']>) => set('exporter', { ...invoice.exporter, ...patch });
  const consignee = (patch: Partial<InvoiceState['consignee']>) => set('consignee', { ...invoice.consignee, ...patch });
  const shipment = (patch: Partial<InvoiceState['shipment']>) => set('shipment', { ...invoice.shipment, ...patch });
  const bank = (patch: Partial<InvoiceState['bank']>) => set('bank', { ...invoice.bank, ...patch });
  const packing = (patch: Partial<InvoiceState['packing']>) => set('packing', { ...invoice.packing, ...patch });
  const declarations = (patch: Partial<InvoiceState['declarations']>) => set('declarations', { ...invoice.declarations, ...patch });

  const jump = (section: SectionKey) => {
    const target = scroller.current?.querySelector<HTMLElement>(`#invoice-section-${section}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const jumpToIssue = (issue: InvoiceIssue) => {
    jump(issue.section);
    setChecksOpen(false);
  };

  const ready = counts.errors === 0;
  const netWeightGrams = Math.round(totals.carats * 0.2 * 1000) / 1000;

  return (
    <EditorContext.Provider value={{ issues: byField, showAll }}>
      <div className="flex h-full flex-col bg-slate-50">
        {/* Section jump bar, with problems per section */}
        <nav aria-label="Invoice sections" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
          {SECTIONS.map(({ key, label }) => {
            const section = counts.bySection[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => jump(key)}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                {section.errors > 0 ? (
                  <XCircle className="h-3.5 w-3.5 text-red-600" />
                ) : section.warnings > 0 ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                )}
                {label}
              </button>
            );
          })}
        </nav>

        <div ref={scroller} className="flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            {/* Readiness (stays usable on a locked invoice) */}
            <div className={`rounded-xl border ${ready ? (counts.warnings ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50') : 'border-red-200 bg-red-50'}`}>
              <button type="button" onClick={() => setChecksOpen((open) => !open)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {ready ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-700" />
                  )}
                  {issued
                    ? issues.length
                      ? `${issues.length} check${issues.length === 1 ? '' : 's'} flagged on this invoice`
                      : 'All checks pass'
                    : ready
                    ? counts.warnings
                      ? `Ready to issue · ${counts.warnings} thing${counts.warnings === 1 ? '' : 's'} to review`
                      : 'Ready to issue · all checks pass'
                    : `${counts.errors} thing${counts.errors === 1 ? '' : 's'} to fix before issuing${counts.warnings ? ` · ${counts.warnings} to review` : ''}`}
                </span>
                {issues.length > 0 && (checksOpen ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />)}
              </button>
              {checksOpen && issues.length > 0 && (
                <ul className="max-h-60 space-y-0.5 overflow-y-auto border-t border-black/5 px-2 py-2">
                  {[...issues]
                    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
                    .map((issue, index) => (
                      <li key={`${issue.field}-${index}`}>
                        <button
                          type="button"
                          onClick={() => jumpToIssue(issue)}
                          className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-white/70"
                        >
                          {issue.severity === 'error' ? <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-600" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />}
                          <span className="text-slate-800">
                            <span className="font-semibold">{SECTIONS.find((section) => section.key === issue.section)?.label}:</span> {issue.message}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>

            <fieldset disabled={locked} className="min-w-0 space-y-4">
            <Section
              id="invoice-section-parties"
              title="Parties"
              description="Who is shipping, who receives the goods, and who pays, if that is someone else."
              counts={counts.bySection.parties}
            >
              <SubHeading>Exporter</SubHeading>
              <p className="-mt-2 text-[11px] text-slate-500">Filled from the company profile. Change it there to update every new invoice.</p>
              <div className={grid}>
                <TextField className="sm:col-span-2" label="Company name" required field="exporter.companyName" value={invoice.exporter.companyName} onChange={(value) => exporter({ companyName: value })} />
                <TextField label="Address line 1" required field="exporter.addressLine1" value={invoice.exporter.addressLine1} onChange={(value) => exporter({ addressLine1: value })} />
                <TextField label="Address line 2" value={invoice.exporter.addressLine2} onChange={(value) => exporter({ addressLine2: value })} />
                <TextField label="City" value={invoice.exporter.city} onChange={(value) => exporter({ city: value })} />
                <TextField label="PIN code" value={invoice.exporter.pincode} onChange={(value) => exporter({ pincode: value })} />
                <TextField label="State" value={invoice.exporter.state} onChange={(value) => exporter({ state: value })} />
                <TextField label="State code" placeholder="24" field="exporter.stateCode" value={invoice.exporter.stateCode} onChange={(value) => exporter({ stateCode: value })} />
                <TextField label="IEC" required mono uppercase maxLength={10} field="exporter.iec" value={invoice.exporter.iec} onChange={(value) => exporter({ iec: value })} />
                <TextField label="GSTIN" required mono uppercase maxLength={15} field="exporter.gstin" value={invoice.exporter.gstin} onChange={(value) => exporter({ gstin: value })} />
                <TextField label="PAN" mono uppercase maxLength={10} field="exporter.pan" value={invoice.exporter.pan} onChange={(value) => exporter({ pan: value })} />
                <TextField label="GJEPC RCMC number" mono field="exporter.rcmcNo" value={invoice.exporter.rcmcNo} onChange={(value) => exporter({ rcmcNo: value })} />
                <TextField label="Email" type="email" value={invoice.exporter.email} onChange={(value) => exporter({ email: value })} />
                <TextField label="Phone" type="tel" value={invoice.exporter.phone} onChange={(value) => exporter({ phone: value })} />
              </div>

              <div className="flex flex-wrap items-end justify-between gap-2 border-t border-slate-100 pt-4">
                <SubHeading>Consignee</SubHeading>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="Fill from a saved buyer"
                    value=""
                    disabled={buyers.length === 0}
                    onChange={(event) => onPickBuyer(event.target.value)}
                    className="max-w-[14rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-60"
                  >
                    <option value="">{buyers.length === 0 ? 'No saved buyers' : 'Fill from a saved buyer…'}</option>
                    {buyers.map((buyer) => (
                      <option key={buyer.id} value={buyer.id}>
                        {buyer.name}
                        {buyer.consignee.country ? ` (${buyer.consignee.country})` : ''}
                      </option>
                    ))}
                  </select>
                  {onSaveBuyer && (
                    <button
                      type="button"
                      onClick={onSaveBuyer}
                      disabled={!invoice.consignee.companyName.trim()}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                    >
                      <UserPlus className="h-3.5 w-3.5" /> Save buyer
                    </button>
                  )}
                </div>
              </div>
              <div className={grid}>
                <TextField className="sm:col-span-2" label="Company name" required field="consignee.companyName" value={invoice.consignee.companyName} onChange={(value) => consignee({ companyName: value })} />
                <TextField label="Address line 1" required field="consignee.addressLine1" value={invoice.consignee.addressLine1} onChange={(value) => consignee({ addressLine1: value })} />
                <TextField label="Address line 2" value={invoice.consignee.addressLine2} onChange={(value) => consignee({ addressLine2: value })} />
                <TextField label="City" value={invoice.consignee.city} onChange={(value) => consignee({ city: value })} />
                <TextField label="Postal code" value={invoice.consignee.postalCode} onChange={(value) => consignee({ postalCode: value })} />
                <TextField label="State / region" value={invoice.consignee.state} onChange={(value) => consignee({ state: value })} />
                <TextField label="Country" required field="consignee.country" value={invoice.consignee.country} onChange={(value) => consignee({ country: value })} />
                <TextField label="Tax ID / VAT" mono value={invoice.consignee.taxIdVat} onChange={(value) => consignee({ taxIdVat: value })} />
                <TextField label="Contact person" value={invoice.consignee.contactPerson} onChange={(value) => consignee({ contactPerson: value })} />
                <TextField label="Email" type="email" hint="Used for invoice email and payment reminders." value={invoice.consignee.email} onChange={(value) => consignee({ email: value })} />
                <TextField label="Phone" type="tel" value={invoice.consignee.phone} onChange={(value) => consignee({ phone: value })} />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={invoice.consignee.buyerOtherThanConsignee}
                  onChange={(event) => consignee({ buyerOtherThanConsignee: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300"
                />
                The buyer (bill to) is not the consignee
              </label>
              {invoice.consignee.buyerOtherThanConsignee && (
                <div className={grid}>
                  <TextField label="Buyer name" required field="consignee.buyerName" value={invoice.consignee.buyerName} onChange={(value) => consignee({ buyerName: value })} />
                  <TextField label="Buyer country" value={invoice.consignee.buyerCountry} onChange={(value) => consignee({ buyerCountry: value })} />
                  <TextField className="sm:col-span-2" label="Buyer address" value={invoice.consignee.buyerAddress} onChange={(value) => consignee({ buyerAddress: value })} />
                  <TextField label="Buyer tax ID" mono value={invoice.consignee.buyerTaxId} onChange={(value) => consignee({ buyerTaxId: value })} />
                </div>
              )}
            </Section>

            <Section id="invoice-section-shipment" title="Shipment" description="Invoice reference, terms of sale, route, and carrier." counts={counts.bySection.shipment}>
              <div className={grid}>
                <TextField
                  label="Invoice number"
                  mono
                  placeholder="Assigned when you save"
                  hint="Leave blank for the next number in this financial year."
                  value={invoice.shipment.invoiceNumber}
                  onChange={(value) => shipment({ invoiceNumber: value })}
                />
                <TextField label="Invoice date" type="date" required field="shipment.invoiceDate" value={invoice.shipment.invoiceDate} onChange={(value) => shipment({ invoiceDate: value })} />
                <TextField label="Exporter's reference" value={invoice.shipment.exporterRef} onChange={(value) => shipment({ exporterRef: value })} />
                <TextField label="Buyer's order number" value={invoice.shipment.buyerOrderRef} onChange={(value) => shipment({ buyerOrderRef: value })} />
              </div>
              <SubHeading>Terms</SubHeading>
              <div className={grid}>
                <SelectField label="Incoterms" value={invoice.shipment.incoterms} options={INCOTERMS} onChange={(value) => shipment({ incoterms: value as InvoiceState['shipment']['incoterms'] })} />
                <TextField label="Incoterm place" placeholder="Antwerp" field="shipment.incotermLocation" value={invoice.shipment.incotermLocation} onChange={(value) => shipment({ incotermLocation: value })} />
                <TextField label="Payment terms" placeholder="60 days from date of invoice, by TT" field="shipment.paymentTerms" value={invoice.shipment.paymentTerms} onChange={(value) => shipment({ paymentTerms: value })} />
                <NumberField label="Credit days" integer suffix="days" hint="Payment is overdue after this many days." field="shipment.creditDays" value={invoice.shipment.creditDays} onChange={(value) => shipment({ creditDays: value })} />
              </div>
              <SubHeading>Route</SubHeading>
              <div className={grid}>
                <TextField label="Port of loading" required field="shipment.portOfLoading" placeholder="Mumbai Air Cargo (INBOM4)" value={invoice.shipment.portOfLoading} onChange={(value) => shipment({ portOfLoading: value })} />
                <TextField label="Port of discharge" required field="shipment.portOfDischarge" placeholder="Antwerp (BEANR)" value={invoice.shipment.portOfDischarge} onChange={(value) => shipment({ portOfDischarge: value })} />
                <TextField label="Country of origin" value={invoice.shipment.countryOfOrigin} onChange={(value) => shipment({ countryOfOrigin: value })} />
                <TextField label="Country of final destination" required field="shipment.countryOfDestination" value={invoice.shipment.countryOfDestination} onChange={(value) => shipment({ countryOfDestination: value })} />
              </div>
              <SubHeading>Carrier</SubHeading>
              <div className={grid}>
                <TextField label="Carrier" placeholder="Brink's, Malca-Amit, Ferrari" field="shipment.carrierName" value={invoice.shipment.carrierName} onChange={(value) => shipment({ carrierName: value })} />
                <TextField label="Flight" mono uppercase value={invoice.shipment.flightNumber} onChange={(value) => shipment({ flightNumber: value })} />
                <TextField label="Air waybill number" mono uppercase field="shipment.awbNumber" value={invoice.shipment.awbNumber} onChange={(value) => shipment({ awbNumber: value })} />
                <TextField label="Insurance policy" mono value={invoice.shipment.insurancePolicyNo} onChange={(value) => shipment({ insurancePolicyNo: value })} />
              </div>
            </Section>

            <Section id="invoice-section-goods" title="Goods" description="One line per lot. Amounts are carats × rate per carat, in US dollars." counts={counts.bySection.goods}>
              <LineItemsEditor items={invoice.items} onChange={(items) => set('items', items)} onReadManifest={onReadManifest} />
              <SubHeading>Charges and exchange rate</SubHeading>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberField label="Freight" prefix="$" field="freightUsd" value={invoice.freightUsd} onChange={(value) => set('freightUsd', value)} />
                <NumberField label="Insurance" prefix="$" field="insuranceUsd" value={invoice.insuranceUsd} onChange={(value) => set('insuranceUsd', value)} />
                <NumberField label="Other charges" prefix="$" field="otherChargesUsd" value={invoice.otherChargesUsd} onChange={(value) => set('otherChargesUsd', value)} />
                <NumberField label="Rate (₹ per $)" required hint="Customs notified rate." field="exchangeRateInr" value={invoice.exchangeRateInr} onChange={(value) => set('exchangeRateInr', value)} />
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-slate-900 px-4 py-3 text-xs text-slate-300 sm:grid-cols-4">
                <div><dt>Lines</dt><dd className="font-mono text-sm text-white">{totals.lines}</dd></div>
                <div><dt>Pieces</dt><dd className="font-mono text-sm text-white">{totals.pieces}</dd></div>
                <div><dt>Carats</dt><dd className="font-mono text-sm text-white">{totals.carats.toFixed(3)}</dd></div>
                <div><dt>Average per carat</dt><dd className="font-mono text-sm text-white">{usd(totals.averageRateUsd)}</dd></div>
                <div><dt>Goods</dt><dd className="font-mono text-sm text-white">{usd(totals.goodsUsd)}</dd></div>
                <div><dt>Charges</dt><dd className="font-mono text-sm text-white">{usd(totals.chargesUsd)}</dd></div>
                <div><dt>Invoice total</dt><dd className="font-mono text-base font-semibold text-white">{usd(totals.totalUsd)}</dd></div>
                <div><dt>In rupees</dt><dd className="font-mono text-sm text-white">{inr(totals.totalInr)}</dd></div>
              </dl>
            </Section>

            <Section id="invoice-section-packing" title="Packing" description="Sealed parcel details for customs and the carrier." counts={counts.bySection.packing}>
              <div className={grid}>
                <TextField label="Vault box number" mono value={invoice.packing.vaultBoxNo} onChange={(value) => packing({ vaultBoxNo: value })} />
                <TextField label="Tamper seal number" mono field="packing.tamperSealNo" value={invoice.packing.tamperSealNo} onChange={(value) => packing({ tamperSealNo: value })} />
                <TextField label="Security bag number" mono value={invoice.packing.securityBagNo} onChange={(value) => packing({ securityBagNo: value })} />
                <NumberField label="Number of packages" integer field="packing.numberOfPackages" value={invoice.packing.numberOfPackages} onChange={(value) => packing({ numberOfPackages: value })} />
                <TextField label="Package dimensions" placeholder="35 × 25 × 15 cm" value={invoice.packing.packageDimensions} onChange={(value) => packing({ packageDimensions: value })} />
                <NumberField label="Tare weight" suffix="g" field="packing.tareWeightGrams" value={invoice.packing.tareWeightGrams} onChange={(value) => packing({ tareWeightGrams: value })} />
                <NumberField
                  label="Gross weight"
                  suffix="g"
                  hint={`Net weight of the stones is about ${netWeightGrams} g (1 ct = 0.2 g).`}
                  value={invoice.packing.grossWeightGrams}
                  onChange={(value) => packing({ grossWeightGrams: value })}
                />
              </div>
            </Section>

            <Section id="invoice-section-bank" title="Bank" description="Where the buyer pays, and the AD code customs needs on the shipping bill." counts={counts.bySection.bank}>
              <div className={grid}>
                <TextField label="Bank name" required field="bank.bankName" value={invoice.bank.bankName} onChange={(value) => bank({ bankName: value })} />
                <TextField label="Branch" value={invoice.bank.branch} onChange={(value) => bank({ branch: value })} />
                <TextField label="Account number" required mono field="bank.accountNumber" value={invoice.bank.accountNumber} onChange={(value) => bank({ accountNumber: value })} />
                <TextField label="IFSC" mono uppercase maxLength={11} field="bank.ifscCode" value={invoice.bank.ifscCode} onChange={(value) => bank({ ifscCode: value })} />
                <TextField label="SWIFT / BIC" required mono uppercase maxLength={11} field="bank.swiftCode" value={invoice.bank.swiftCode} onChange={(value) => bank({ swiftCode: value })} />
                <TextField label="AD code" required mono hint="14-digit authorised dealer code registered with customs." field="bank.adCode" value={invoice.bank.adCode} onChange={(value) => bank({ adCode: value })} />
                <TextField label="IBAN" mono uppercase value={invoice.bank.iban} onChange={(value) => bank({ iban: value })} />
                <TextField label="Correspondent bank" value={invoice.bank.correspondentBank} onChange={(value) => bank({ correspondentBank: value })} />
                <TextField label="Correspondent SWIFT" mono uppercase maxLength={11} value={invoice.bank.correspondentSwift} onChange={(value) => bank({ correspondentSwift: value })} />
              </div>
            </Section>

            <Section id="invoice-section-compliance" title="Compliance" description="Certificates, the GST LUT, the declarations printed on the invoice, and who signs." counts={counts.bySection.compliance}>
              <div className={grid}>
                <TextField label="Kimberley Process certificate" mono uppercase hint="Needed when any line is rough (HS 7102.10, .21, .31)." field="shipment.kpcsNumber" value={invoice.shipment.kpcsNumber} onChange={(value) => shipment({ kpcsNumber: value })} />
                <TextField label="LUT ARN" mono uppercase hint="For zero-rated export without paying IGST." field="shipment.lutNumber" value={invoice.shipment.lutNumber} onChange={(value) => shipment({ lutNumber: value })} />
              </div>
              <div className="space-y-2">
                <DeclarationField
                  field="declarations.kimberleyClause"
                  checked={invoice.declarations.kimberleyClause}
                  onChange={(value) => declarations({ kimberleyClause: value })}
                  title="Kimberley Process System of Warranties"
                  text="The diamonds have been purchased from legitimate sources not involved in funding conflict, in compliance with UN resolutions."
                />
                <DeclarationField
                  field="declarations.naturalDiamondAffirmation"
                  checked={invoice.declarations.naturalDiamondAffirmation}
                  onChange={(value) => declarations({ naturalDiamondAffirmation: value })}
                  title="Natural diamonds"
                  text="The goods are natural, earth-mined diamonds, not laboratory-grown."
                />
                <DeclarationField
                  field="declarations.gjepcOriginClause"
                  checked={invoice.declarations.gjepcOriginClause}
                  onChange={(value) => declarations({ gjepcOriginClause: value })}
                  title="Indian origin under GJEPC RCMC"
                  text="Manufactured in India under the GJEPC membership shown, from rough imported under a valid Kimberley Process certificate."
                />
                <DeclarationField
                  field="declarations.lutSupplyClause"
                  checked={invoice.declarations.lutSupplyClause}
                  onChange={(value) => declarations({ lutSupplyClause: value })}
                  title="Export under LUT without IGST"
                  text="Supply meant for export under Letter of Undertaking without payment of IGST, under section 16(3) of the IGST Act, 2017."
                />
              </div>
              <div className={grid}>
                <TextField label="Authorised signatory" required field="authorizedSignatoryName" value={invoice.authorizedSignatoryName} onChange={(value) => set('authorizedSignatoryName', value)} />
                <TextField label="Designation" placeholder="Director" value={invoice.authorizedSignatoryDesignation} onChange={(value) => set('authorizedSignatoryDesignation', value)} />
              </div>
            </Section>
            </fieldset>
          </div>
        </div>
      </div>
    </EditorContext.Provider>
  );
};
