import { InvoiceState } from '../types/invoice';

/**
 * Generates SAP S/4HANA Enterprise OData Payload for Sales Order Creation (API_SALES_ORDER_SRV)
 * Matches standard SAP SD module fields:
 * - Header: SalesOrderType, SalesOrganization, DistributionChannel, Division, Incoterms, TransactionCurrency (USD)
 * - Items: Material, RequestedQuantityInBaseUnit, SalesOrderItemCategory (ZTAN - Export Diamond)
 * - Partners: SoldToParty, ShipToParty, ForwardingAgent (Brink's), CustomsBroker
 * - Header Texts: Kimberley Process Declaration, LUT Reference
 */
export function generateSapODataPayload(invoice: InvoiceState) {
  const totalUSD = invoice.items.reduce((sum, item) => sum + item.totalAmount, 0) +
    invoice.freightUsd + invoice.insuranceUsd + invoice.otherChargesUsd;

  return {
    "d": {
      "SalesOrder": "",
      "SalesOrderType": "OR_EXP", // Standard Export Sales Order
      "SalesOrganization": "1000",
      "DistributionChannel": "10",
      "OrganizationDivision": "00",
      "SalesDistrict": "OVERSEAS",
      "TotalNetAmount": totalUSD.toFixed(2),
      "TransactionCurrency": "USD",
      "PricingDate": invoice.shipment.invoiceDate,
      "CustomerPurchaseOrderDate": invoice.shipment.invoiceDate,
      "PurchaseOrderByCustomer": invoice.shipment.buyerOrderRef || invoice.shipment.invoiceNumber,
      "IncotermsClassification": invoice.shipment.incoterms,
      "IncotermsTransferLocation": invoice.shipment.incotermLocation,
      "CustomerPaymentTerms": "NT30", // or LC60
      "PaymentMethod": "T", // Bank Wire / LC
      "ReferenceSDDocument": invoice.shipment.invoiceNumber,
      "CustomerAccountAssignmentGroup": "02", // Foreign Revenues
      "AccountingExchangeRate": invoice.exchangeRateInr.toFixed(2),
      
      // Header Partner Functions
      "to_Partner": [
        {
          "PartnerFunction": "SP", // Sold-To Party
          "Customer": invoice.consignee.taxIdVat || "CUST-OVERSEAS-01",
          "FullName": invoice.consignee.companyName,
          "StreetName": invoice.consignee.addressLine1,
          "CityName": invoice.consignee.city,
          "Country": invoice.consignee.country,
        },
        {
          "PartnerFunction": "SH", // Ship-To Party
          "Customer": invoice.consignee.taxIdVat || "CUST-OVERSEAS-01",
          "FullName": invoice.consignee.companyName,
          "StreetName": invoice.consignee.addressLine1,
          "CityName": invoice.consignee.city,
          "Country": invoice.consignee.country,
        },
        {
          "PartnerFunction": "CR", // Forwarding Carrier
          "FullName": invoice.shipment.carrierName,
          "ReferenceIdentifier": invoice.shipment.awbNumber,
        }
      ],

      // Header Texts & Statutory Customs Declarations
      "to_Text": [
        {
          "Language": "EN",
          "LongTextID": "0001", // Invoice Remarks
          "LongText": `SUPPLY UNDER LUT ARN: ${invoice.shipment.lutNumber} WITHOUT IGST. KPCS: ${invoice.shipment.kpcsNumber}. GJEPC RCMC: ${invoice.exporter.rcmcNo}. AD CODE: ${invoice.bank.adCode}.`
        },
        {
          "Language": "EN",
          "LongTextID": "0002", // Kimberley Process
          "LongText": "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict and in compliance with United Nations Resolutions and KPCS."
        }
      ],

      // Itemized Diamond Positions
      "to_Item": invoice.items.map((item, idx) => ({
        "SalesOrderItem": ((idx + 1) * 10).toString().padStart(6, '0'),
        "Material": `DIAMOND-7102-${item.hsCode.replace(/\./g, '')}`,
        "SalesOrderItemText": item.description,
        "SalesOrderItemCategory": "ZTAN", // Export Tax-Exempt Diamond Item
        "RequestedQuantity": item.carats.toFixed(3),
        "RequestedQuantityUnit": "CTS", // Carat
        "AlternativeItemGrossWeight": (item.carats * 0.2).toFixed(4), // 1 ct = 0.2 grams
        "ItemGrossWeightUnit": "GRM",
        "NetPriceAmount": item.ratePerCarat.toFixed(2),
        "NetPriceQuantity": "1",
        "NetPriceQuantityUnit": "CTS",
        "TransactionCurrency": "USD",
        "CommodityCode": item.hsCode,
        "Batch": item.parcelId || `LOT-${idx + 1}`,
        "CertificateNumber": item.certificateNo || "N/A",
        "NumberPieces": item.pieces,
        
        // Pricing Conditions
        "to_PricingElement": [
          {
            "ConditionType": "PR00", // Base Price
            "ConditionRateValue": item.ratePerCarat.toFixed(2),
            "ConditionCurrency": "USD",
            "ConditionQuantity": "1",
            "ConditionQuantityUnit": "CTS",
          },
          {
            "ConditionType": "ZEXP", // Export Zero-Rated GST
            "ConditionRateValue": "0.00",
            "ConditionCurrency": "USD",
          }
        ]
      }))
    }
  };
}
