import { InvoiceState } from '../types/invoice';

/**
 * Generates official Tally Prime XML Sales Voucher
 * Handles:
 * - Foreign Exchange (USD) & base conversion (INR)
 * - Zero-rated GST Supply under Letter of Undertaking (LUT)
 * - Diamond UOM in Carats (CTS)
 * - Statutory Export Narration with Kimberley & GJEPC details
 */
export function generateTallyPrimeXML(invoice: InvoiceState): string {
  const invoiceTotalUSD = invoice.items.reduce((sum, item) => sum + item.totalAmount, 0) +
    invoice.freightUsd + invoice.insuranceUsd + invoice.otherChargesUsd;
  
  const exchangeRate = invoice.exchangeRateInr || 86.50;
  const invoiceTotalINR = (invoiceTotalUSD * exchangeRate).toFixed(2);
  const formattedDate = invoice.shipment.invoiceDate.replace(/-/g, ''); // YYYYMMDD for Tally

  const xmlInventoryEntries = invoice.items.map((item, idx) => {
    const itemTotalINR = (item.totalAmount * exchangeRate).toFixed(2);
    const itemRateINR = (item.ratePerCarat * exchangeRate).toFixed(2);

    return `        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>${escapeXml(item.description)}</STOCKITEMNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <RATE>$ ${item.ratePerCarat.toFixed(2)}/CTS</RATE>
          <AMOUNT>-$ ${item.totalAmount.toFixed(2)}</AMOUNT>
          <ACTUALQTY>${item.carats.toFixed(3)} CTS</ACTUALQTY>
          <BILLEDQTY>${item.carats.toFixed(3)} CTS</BILLEDQTY>
          <BATCHNAME>LOT-${item.parcelId || `P-${idx + 1}`}</BATCHNAME>
          <HSNCODE>${item.hsCode}</HSNCODE>
          <CERTIFICATENO>${escapeXml(item.certificateNo || 'N/A')}</CERTIFICATENO>
          <BASEAMOUNT>-${itemTotalINR}</BASEAMOUNT>
          <BASERATE>${itemRateINR}/CTS</BASERATE>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>Export Diamond Sales (Zero Rated LUT)</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>-$ ${item.totalAmount.toFixed(2)}</AMOUNT>
            <BASEAMOUNT>-${itemTotalINR}</BASEAMOUNT>
          </ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>`;
  }).join('\n');

  const narration = `Diamond Export Shipment under LUT ARN: ${invoice.shipment.lutNumber} without payment of IGST. KPCS Ref: ${invoice.shipment.kpcsNumber}. GJEPC RCMC: ${invoice.exporter.rcmcNo}. AWB: ${invoice.shipment.awbNumber}. Carrier: ${invoice.shipment.carrierName}. Incoterms: ${invoice.shipment.incoterms} ${invoice.shipment.incotermLocation}. Bank AD Code: ${invoice.bank.adCode}.`;

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(invoice.exporter.companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales - Export LUT" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${formattedDate}</DATE>
            <VOUCHERTYPENAME>Sales - Export</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(invoice.shipment.invoiceNumber)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${escapeXml(invoice.consignee.companyName)}</PARTYLEDGERNAME>
            <PARTYNAME>${escapeXml(invoice.consignee.companyName)}</PARTYNAME>
            <BASICBASEPARTYNAME>${escapeXml(invoice.consignee.companyName)}</BASICBASEPARTYNAME>
            <PLACEOFSUPPLY>Other Territory</PLACEOFSUPPLY>
            <STATENAME>Overseas</STATENAME>
            <COUNTRYOFORIGIN>India</COUNTRYOFORIGIN>
            <COUNTRYOFDESTINATION>${escapeXml(invoice.shipment.countryOfDestination)}</COUNTRYOFDESTINATION>
            <PORTNAME>${escapeXml(invoice.shipment.portOfLoading)}</PORTNAME>
            <PORTCODE>${escapeXml(invoice.bank.adCode)}</PORTCODE>
            <SHIPPINGBILLNO>PENDING-LEO</SHIPPINGBILLNO>
            <CURRENCYNAME>USD</CURRENCYNAME>
            <BASECURRENCYNAME>INR</BASECURRENCYNAME>
            <BASICCURRENCYRATE>${exchangeRate.toFixed(2)}</BASICCURRENCYRATE>
            <NARRATION>${escapeXml(narration)}</NARRATION>
            
            <!-- Consignee Ledger Debit -->
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(invoice.consignee.companyName)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>$ ${invoiceTotalUSD.toFixed(2)}</AMOUNT>
              <BASEAMOUNT>${invoiceTotalINR}</BASEAMOUNT>
            </ALLLEDGERENTRIES.LIST>

            <!-- Export Inventory Allocations -->
${xmlInventoryEntries}

            <!-- Freight & Insurance Charges if applicable -->
            ${invoice.freightUsd > 0 ? `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>International Freight Charges (Export)</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>-$ ${invoice.freightUsd.toFixed(2)}</AMOUNT>
              <BASEAMOUNT>-${(invoice.freightUsd * exchangeRate).toFixed(2)}</BASEAMOUNT>
            </ALLLEDGERENTRIES.LIST>` : ''}
            ${invoice.insuranceUsd > 0 ? `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Marine Transit Insurance (Export)</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>-$ ${invoice.insuranceUsd.toFixed(2)}</AMOUNT>
              <BASEAMOUNT>-${(invoice.insuranceUsd * exchangeRate).toFixed(2)}</BASEAMOUNT>
            </ALLLEDGERENTRIES.LIST>` : ''}

          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function escapeXml(unsafe: string): string {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}
