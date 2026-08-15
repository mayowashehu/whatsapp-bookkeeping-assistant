import { createMetaApiClient } from '../meta/MetaApiClient.js';
import { truncateSenderId } from '../../utils/safeLog.js';

/**
 * WhatsApp document operations only (upload + send).
 * Uses the shared Meta upload pipeline so images/CSV can reuse the same client later.
 */
export function createWhatsAppDocumentService(deps = {}) {
  const metaClient = deps.metaClient || createMetaApiClient();

  /**
   * Uploads a local file through the reusable Meta media pipeline.
   */
  async function uploadDocument({ filePath, filename, mimeType = 'application/pdf' }) {
    console.log(
      `[WhatsAppDocumentService] Uploading document filename=${filename} mimeType=${mimeType}`,
    );

    const result = await metaClient.uploadMedia({
      filePath,
      filename,
      mimeType,
    });

    if (!result.success) {
      console.error(
        `[WhatsAppDocumentService] Upload failure code=${result.error?.code} message=${result.error?.message}`,
      );
      return {
        success: false,
        data: null,
        error: mapUploadError(result.error),
      };
    }

    console.log(
      `[WhatsAppDocumentService] Upload success mediaId=${result.data.mediaId}`,
    );

    return {
      success: true,
      data: {
        mediaId: result.data.mediaId,
      },
      error: null,
    };
  }

  /**
   * Sends an already-uploaded document by media id.
   */
  async function sendDocument({ phoneNumber, mediaId, filename, caption }) {
    const payload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'document',
      document: {
        id: mediaId,
        filename,
      },
    };

    if (caption) {
      payload.document.caption = String(caption);
    }

    console.log(
      `[WhatsAppDocumentService] Sending document sender=${truncateSenderId(phoneNumber)} mediaId=${mediaId} filename=${filename}`,
    );

    const result = await metaClient.sendMessage(payload);

    if (!result.success) {
      console.error(
        `[WhatsAppDocumentService] Send failure code=${result.error?.code} message=${result.error?.message}`,
      );
      return {
        success: false,
        data: null,
        error: mapSendError(result.error),
      };
    }

    const messageId = result.data?.messages?.[0]?.id || null;
    if (!messageId) {
      return {
        success: false,
        data: null,
        error: {
          code: 'WHATSAPP_SEND_FAILED',
          message: 'WhatsApp send response did not include a message id',
        },
      };
    }

    console.log(
      `[WhatsAppDocumentService] Send success messageId=${messageId}`,
    );

    return {
      success: true,
      data: {
        messageId: String(messageId),
        mediaId,
      },
      error: null,
    };
  }

  return {
    uploadDocument,
    sendDocument,
  };
}

function mapUploadError(error) {
  if (!error) {
    return { code: 'UPLOAD_FAILURE', message: 'Document upload failed' };
  }
  if (error.code === 'WHATSAPP_AUTH_ERROR') {
    return error;
  }
  if (error.code === 'WHATSAPP_TIMEOUT') {
    return error;
  }
  if (error.code === 'WHATSAPP_MEDIA_ID_MISSING') {
    return {
      code: 'MEDIA_ID_FAILURE',
      message: error.message,
    };
  }
  return {
    code: 'UPLOAD_FAILURE',
    message: error.message || 'Document upload failed',
  };
}

function mapSendError(error) {
  if (!error) {
    return { code: 'SEND_FAILURE', message: 'Document send failed' };
  }
  if (error.code === 'WHATSAPP_AUTH_ERROR' || error.code === 'WHATSAPP_TIMEOUT') {
    return error;
  }
  return {
    code: 'SEND_FAILURE',
    message: error.message || 'Document send failed',
  };
}

export default {
  createWhatsAppDocumentService,
};
