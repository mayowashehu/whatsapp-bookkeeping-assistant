import path from 'node:path';
import { createWhatsAppDocumentService } from './WhatsAppDocumentService.js';
import { normalizeWhatsAppPhoneNumber } from './phoneNumber.js';
import { validatePdfFile } from './pdfValidation.js';

/**
 * DocumentDeliveryManager — orchestration only.
 * Validates inputs, coordinates upload + send, returns structured results.
 * Never talks to Meta directly.
 */
export function createDocumentDeliveryManager(deps = {}) {
  const documentService = deps.documentService || createWhatsAppDocumentService();

  /**
   * @param {{ phoneNumber: string, pdfPath: string, filename?: string, caption?: string }} input
   */
  async function deliverDocument(input = {}) {
    const deliveredAt = new Date().toISOString();

    const phone = normalizeWhatsAppPhoneNumber(input.phoneNumber);
    if (!phone.ok) {
      return buildResult({
        success: false,
        error: phone.error,
        deliveredAt,
      });
    }

    const pdfCheck = await validatePdfFile(input.pdfPath);
    if (!pdfCheck.ok) {
      return buildResult({
        success: false,
        error: pdfCheck.error,
        deliveredAt,
      });
    }

    const filename =
      (input.filename && String(input.filename).trim()) ||
      path.basename(input.pdfPath) ||
      'statement.pdf';

    const upload = await documentService.uploadDocument({
      filePath: input.pdfPath,
      filename,
      mimeType: pdfCheck.mimeType,
    });

    if (!upload.success) {
      return buildResult({
        success: false,
        error: upload.error,
        deliveredAt,
        mediaId: null,
      });
    }

    const mediaId = upload.data.mediaId;

    const send = await documentService.sendDocument({
      phoneNumber: phone.phoneNumber,
      mediaId,
      filename,
      caption: input.caption || undefined,
    });

    if (!send.success) {
      return buildResult({
        success: false,
        error: send.error,
        deliveredAt,
        mediaId,
      });
    }

    return buildResult({
      success: true,
      messageId: send.data.messageId,
      mediaId,
      deliveredAt,
      error: null,
    });
  }

  return {
    deliverDocument,
  };
}

function buildResult({
  success,
  messageId = null,
  mediaId = null,
  deliveredAt,
  error = null,
}) {
  return {
    success: Boolean(success),
    messageId,
    mediaId,
    deliveredAt,
    error,
    // Standardized envelope for services that prefer { success, data, error }
    data: success
      ? {
          messageId,
          mediaId,
          deliveredAt,
        }
      : null,
  };
}

const defaultManager = createDocumentDeliveryManager();

export const deliverDocument = defaultManager.deliverDocument;

export default {
  createDocumentDeliveryManager,
  deliverDocument,
};
