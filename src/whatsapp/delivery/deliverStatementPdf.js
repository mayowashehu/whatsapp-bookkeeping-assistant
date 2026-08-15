import { createDocumentDeliveryManager } from './DocumentDeliveryManager.js';
import { deleteTempPdfFile } from '../../pdf/tempPdf.js';

/**
 * Thin integration helper for StatementManager to call later.
 * Does not generate PDFs or query MongoDB — delivery only.
 * Always deletes the temporary PDF in finally (success or failure).
 *
 * @param {{
 *   phoneNumber: string,
 *   pdfPath: string,
 *   filename?: string,
 *   caption?: string,
 *   deliveryManager?: ReturnType<typeof createDocumentDeliveryManager>
 * }} input
 */
export async function deliverStatementPdf(input = {}) {
  const manager = input.deliveryManager || createDocumentDeliveryManager();
  const pdfPath = input.pdfPath;

  try {
    return await manager.deliverDocument({
      phoneNumber: input.phoneNumber,
      pdfPath,
      filename: input.filename || 'property-statement.pdf',
      caption: input.caption,
    });
  } finally {
    await deleteTempPdfFile(pdfPath);
  }
}

export default {
  deliverStatementPdf,
};
