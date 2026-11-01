import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

/**
 * Captures an HTML element and converts it into a high-fidelity A4 PDF.
 * Options:
 * - filename: string
 * - download: boolean (triggers browser download)
 * - returnBase64: boolean (returns base64 data URI for emailing)
 */
export async function exportElementToPdf(
  elementId: string,
  options: {
    filename?: string;
    download?: boolean;
    returnBase64?: boolean;
  } = {}
): Promise<{ pdf?: jsPDF; base64?: string }> {
  const { filename = 'Diamond_Export_Invoice_A1005.pdf', download = true, returnBase64 = false } = options;

  const target = document.getElementById(elementId);
  if (!target) {
    throw new Error(`Element with id "${elementId}" not found for PDF export.`);
  }

  // Clone or capture target element with exact dimensions
  const canvas = await html2canvas(target, {
    scale: 2, // 2x scale for crisp print typography
    useCORS: true,
    logging: false,
    backgroundColor: '#ffffff',
    windowWidth: 1200, // Fixed width for consistent desktop capture
  });

  const imgData = canvas.toDataURL('image/jpeg', 0.98);

  // A4 dimensions in mm: 210 x 297
  const pdf = new jsPDF('p', 'mm', 'a4');
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = pdf.internal.pageSize.getHeight();

  const imgWidth = pdfWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = 0;

  // First page
  pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
  heightLeft -= pdfHeight;

  // Add extra pages if needed
  while (heightLeft > 5) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
    heightLeft -= pdfHeight;
  }

  if (download) {
    pdf.save(filename);
  }

  let base64: string | undefined;
  if (returnBase64) {
    base64 = pdf.output('datauristring');
  }

  return { pdf, base64 };
}
