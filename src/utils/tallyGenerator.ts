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
  const exchangeRate = invoice.exchangeRateInr || 86.50;
  const toPaise = (usd: number) => Math.round(usd * 100);
  const toBasePaise = (usd: number) => Math.round(usd * exchangeRate * 100);
  const money = (paise: number) => (paise / 100).toFixed(2);
  const charges = [
    { ledger: 'International Freight Charges (Export)', usd: invoice.freightUsd },
    { ledger: 'Marine Transit Insurance (Export)', usd: invoice.insuranceUsd },
    { ledger: 'Other Export Charges', usd: invoice.otherChargesUsd },
  ].filter((charge) => charge.usd > 0);

  // Tally rejects vouchers whose debit and credits differ, so the party total is the sum of the rounded lines.
  const creditsUsd = [...invoice.items.map((item) => item.totalAmount), ...charges.map((charge) => charge.usd)];
  const invoiceTotalUSD = money(creditsUsd.reduce((sum, usd) => sum + toPaise(usd), 0));
  const invoiceTotalINR = money(creditsUsd.reduce((sum, usd) => sum + toBasePaise(usd), 0));
  const formattedDate = invoice.shipment.invoiceDate.replace(/-/g, ''); // YYYYMMDD for Tally

  const xmlInventoryEntries = invoice.items.map((item, idx) => {
    const itemTotalINR = money(toBasePaise(item.totalAmount));
    const itemRateINR = money(toBasePaise(item.ratePerCarat));

    return `        <ALLINVENTORYENTRIES.LIST>
          <STOCKITEMNAME>${escapeXml(item.description)}</STOCKITEMNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <RATE>$ ${item.ratePerCarat.toFixed(2)}/CTS</RATE>
          <AMOUNT>-$ ${money(toPaise(item.totalAmount))}</AMOUNT>
          <ACTUALQTY>${item.carats.toFixed(3)} CTS</ACTUALQTY>
          <BILLEDQTY>${item.carats.toFixed(3)} CTS</BILLEDQTY>
          <BATCHNAME>LOT-${escapeXml(item.parcelId || `P-${idx + 1}`)}</BATCHNAME>
          <HSNCODE>${escapeXml(item.hsCode)}</HSNCODE>
          <CERTIFICATENO>${escapeXml(item.certificateNo || 'N/A')}</CERTIFICATENO>
          <BASEAMOUNT>-${itemTotalINR}</BASEAMOUNT>
          <BASERATE>${itemRateINR}/CTS</BASERATE>
          <ACCOUNTINGALLOCATIONS.LIST>
            <LEDGERNAME>Export Diamond Sales (Zero Rated LUT)</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>-$ ${money(toPaise(item.totalAmount))}</AMOUNT>
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
              <AMOUNT>$ ${invoiceTotalUSD}</AMOUNT>
              <BASEAMOUNT>${invoiceTotalINR}</BASEAMOUNT>
            </ALLLEDGERENTRIES.LIST>

            <!-- Export Inventory Allocations -->
${xmlInventoryEntries}

            <!-- Freight, Insurance & Other Charges if applicable -->
${charges.map((charge) => `            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${charge.ledger}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>-$ ${money(toPaise(charge.usd))}</AMOUNT>
              <BASEAMOUNT>-${money(toBasePaise(charge.usd))}</BASEAMOUNT>
            </ALLLEDGERENTRIES.LIST>`).join('\n')}

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
