export interface DiamondItem {
  id: string;
  srNo: number;
  description: string;
  shape?: string;
  colorClarity?: string;
  cutGrade?: string;
  hsCode: string;
  certificateNo: string; // GIA / IGI / HRD
  parcelId: string;
  pieces: number;
  carats: number;
  ratePerCarat: number;
  totalAmount: number;
}

export interface ExporterDetails {
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  stateCode: string; // e.g. 24 (Gujarat) or 27 (Maharashtra)
  pincode: string;
  country: string;
  iec: string; // 10-digit Import Export Code
  gstin: string; // 15-character GSTIN
  pan: string; // 10-character PAN
  rcmcNo: string; // GJEPC RCMC Number
  email: string;
  phone: string;
}

export interface ConsigneeDetails {
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  taxIdVat: string;
  contactPerson: string;
  email: string;
  phone: string;
  buyerOtherThanConsignee: boolean;
  buyerName?: string;
  buyerAddress?: string;
  buyerCountry?: string;
  buyerTaxId?: string;
}

export interface BankDetails {
  bankName: string;
  branch: string;
  accountNumber: string;
  adCode: string; // 14-digit Indian Customs Authorized Dealer Code
  swiftCode: string;
  ifscCode: string;
  iban?: string;
  correspondentBank?: string;
  correspondentSwift?: string;
}

export interface ShipmentDetails {
  invoiceNumber: string;
  invoiceDate: string;
  exporterRef: string;
  buyerOrderRef: string;
  kpcsNumber: string; // Kimberley Process Certificate Scheme Ref
  lutNumber: string; // Letter of Undertaking ARN for zero-rated export
  incoterms: 'CIF' | 'FOB' | 'C&F' | 'DAP' | 'EXW';
  incotermLocation: string;
  paymentTerms: string;
  creditDays: number; // days after the invoice date before payment is overdue
  portOfLoading: string;
  portOfDischarge: string;
  countryOfOrigin: string;
  countryOfDestination: string;
  carrierName: string; // e.g., Brink's Global Services / Malca-Amit / Ferrari
  flightNumber: string;
  awbNumber: string;
  insurancePolicyNo?: string;
}

export interface PackingListDetails {
  vaultBoxNo: string;
  tamperSealNo: string;
  packageDimensions: string; // e.g. 35 x 25 x 15 cm
  numberOfPackages: number;
  tareWeightGrams: number;
  grossWeightGrams: number;
  securityBagNo: string;
}

export interface InvoiceState {
  exporter: ExporterDetails;
  consignee: ConsigneeDetails;
  shipment: ShipmentDetails;
  bank: BankDetails;
  packing: PackingListDetails;
  items: DiamondItem[];
  currency: 'USD';
  exchangeRateInr: number; // e.g. 86.50
  freightUsd: number;
  insuranceUsd: number;
  otherChargesUsd: number;
  declarations: {
    kimberleyClause: boolean;
    naturalDiamondAffirmation: boolean;
    gjepcOriginClause: boolean;
    lutSupplyClause: boolean;
  };
  authorizedSignatoryName: string;
  authorizedSignatoryDesignation: string;
}
