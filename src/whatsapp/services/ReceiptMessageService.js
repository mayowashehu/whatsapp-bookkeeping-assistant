import { logInternalError, logProcessingEvent } from '../../utils/safeLog.js';
import { AI_BUSY_FALLBACK_MESSAGE, isAiUnavailableError } from '../../ai/aiFallback.js';
import {
  RECEIPT_PROCESSING_FALLBACK_MESSAGE,
  RECEIPT_UNREADABLE_MESSAGE,
  isReceiptProcessingError,
  isReceiptServiceBusyError,
} from '../../receipt/receiptFallback.js';
import { createReceiptService } from '../../receipt/createReceiptService.js';
import { deleteTempMediaFile, downloadWhatsAppMedia } from './mediaDownload.service.js';
import { assertSupportedImageMimeType, IMAGE_EXTENSION_BY_MIME } from './imageValidation.service.js';
import { SAFE_WHATSAPP_FALLBACK_REPLY, SEND_FAILURE_FALLBACK_REPLY } from './safeReply.js';
import { sendWhatsAppText } from './whatsappSend.service.js';
import { processMessageContent } from './messageHandlerShared.js';

// Same principle as VoiceMessageService's "I heard: ..." echo: a vision
// model reading a receipt photo can misread a smudged or low-light amount
// just as easily as a transcription model can mishear a noisy voice note.
// Every successful read is echoed back to the user alongside the bot's
// reply so a misread digit can be caught before it turns into a bad
// bookkeeping entry — and nothing here is ever auto-saved regardless: the
// reconstructed sentence still goes through the exact same draft +
// YES-to-confirm flow as typed text (see processMessageContent below).
const READ_PREVIEW_MAX_LENGTH = 300;

export function truncateReadPreview(text, maxLength = READ_PREVIEW_MAX_LENGTH) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trim()}…`;
}

export function prependReadAcknowledgment(readText, replyText) {
  const trimmed = String(readText || '').trim();
  if (!trimmed) {
    return replyText;
  }
  const preview = truncateReadPreview(trimmed);
  return `📸 I read this receipt as: "${preview}"\n\n${replyText}`;
}

/**
 * Chooses the safest, most useful fallback reply for a failure that
 * happened anywhere in the receipt pipeline (download, validation, or the
 * vision call itself). Mirrors VoiceMessageService.selectVoiceFallbackReply.
 */
export function selectReceiptFallbackReply(err) {
  if (isAiUnavailableError(err) || isReceiptServiceBusyError(err)) {
    return AI_BUSY_FALLBACK_MESSAGE;
  }
  if (isReceiptProcessingError(err)) {
    return RECEIPT_PROCESSING_FALLBACK_MESSAGE;
  }
  return SAFE_WHATSAPP_FALLBACK_REPLY;
}

function createDefaultDeps() {
  return {
    downloadWhatsAppMedia,
    deleteTempMediaFile,
    createReceiptService,
    processMessageContent,
    sendWhatsAppText,
    logInternalError,
    logProcessingEvent,
  };
}

/**
 * Builds a receipt-photo handler with injectable dependencies. Production
 * code uses the default export below; tests can pass in fakes for the
 * media/vision/send layers to simulate full requests without any network
 * or database access — same shape as createVoiceMessageHandler.
 */
export function createReceiptMessageHandler(overrides = {}) {
  const deps = { ...createDefaultDeps(), ...overrides };

  /**
   * Thin WhatsApp receipt-photo handler — always replies; never logs the
   * extracted transaction text.
   */
  async function handleReceiptMessage(message) {
    const mediaId = message?.image?.id;
    const caption = message?.image?.caption;
    const messageId = message?.messageId;
    const fromNumber = message?.senderId || message?.phoneNumber;
    const startedAt = Date.now();
    let intent = 'none';
    let status = 'ok';
    let tempFilePath = null;

    try {
      if (!mediaId) {
        status = 'missing_media';
        deps.logInternalError(
          'ReceiptMessageService',
          new Error('Missing image media id'),
          { messageId, senderId: fromNumber },
        );
        await deps.sendWhatsAppText(fromNumber, RECEIPT_PROCESSING_FALLBACK_MESSAGE);
        deps.logProcessingEvent('ReceiptMessageService', {
          messageId,
          intent,
          status: 'fallback_sent',
          durationMs: Date.now() - startedAt,
          senderId: fromNumber,
        });
        return;
      }

      const downloaded = await deps.downloadWhatsAppMedia(mediaId, {
        mimeType: message.image?.mimeType,
        assertSupportedMimeType: assertSupportedImageMimeType,
        extensionByMime: IMAGE_EXTENSION_BY_MIME,
        filePrefix: 'wa-receipt',
      });
      tempFilePath = downloaded.filePath;

      const receiptService = deps.createReceiptService();
      const extraction = await receiptService.extractReceiptText({
        filePath: downloaded.filePath,
        mimeType: downloaded.mimeType,
        caption,
      });

      let replyText;
      let acknowledgeRead = false;

      if (extraction?.unreadable || !extraction?.text) {
        // Vision call succeeded but the model wasn't confident enough to
        // read an amount — trust-first: ask, never guess. Distinct from
        // the catch block below, which is for actual technical failures.
        replyText = RECEIPT_UNREADABLE_MESSAGE;
        status = 'unreadable_receipt';
      } else {
        const result = await deps.processMessageContent({
          content: extraction.text,
          fromNumber,
        });
        if (result?.replyText) {
          replyText = result.replyText;
          acknowledgeRead = true;
        } else {
          replyText = SAFE_WHATSAPP_FALLBACK_REPLY;
          status = 'fallback_no_result';
        }
      }

      if (acknowledgeRead) {
        replyText = prependReadAcknowledgment(extraction.text, replyText);
      }

      const sendResult = await deps.sendWhatsAppText(fromNumber, replyText);
      if (!sendResult.success) {
        status = 'send_failed';
        deps.logInternalError(
          'ReceiptMessageService',
          new Error(sendResult.error?.message || 'Send failed'),
          { messageId, senderId: fromNumber },
        );

        const retryResult = await deps.sendWhatsAppText(fromNumber, SEND_FAILURE_FALLBACK_REPLY);
        status = retryResult.success ? 'send_failed_retry_ok' : 'send_failed_retry_failed';
        if (!retryResult.success) {
          deps.logInternalError(
            'ReceiptMessageService',
            new Error(retryResult.error?.message || 'Retry send failed'),
            { messageId, senderId: fromNumber },
          );
        }
      }

      deps.logProcessingEvent('ReceiptMessageService', {
        messageId,
        intent,
        status,
        durationMs: Date.now() - startedAt,
        senderId: fromNumber,
      });
    } catch (err) {
      status = 'error';
      deps.logInternalError('ReceiptMessageService', err, { messageId, senderId: fromNumber });

      try {
        const fallback = selectReceiptFallbackReply(err);
        const fallbackResult = await deps.sendWhatsAppText(fromNumber, fallback);
        status = fallbackResult.success ? 'fallback_sent' : 'fallback_send_failed';
      } catch (sendErr) {
        deps.logInternalError('ReceiptMessageService', sendErr, {
          messageId,
          senderId: fromNumber,
        });
        status = 'fallback_send_failed';
      }

      deps.logProcessingEvent('ReceiptMessageService', {
        messageId,
        intent,
        status,
        durationMs: Date.now() - startedAt,
        senderId: fromNumber,
      });
    } finally {
      await deps.deleteTempMediaFile(tempFilePath);
    }
  }

  return { handleReceiptMessage };
}

const defaultHandler = createReceiptMessageHandler();

export const handleReceiptMessage = defaultHandler.handleReceiptMessage;

export default {
  handleReceiptMessage,
  createReceiptMessageHandler,
  prependReadAcknowledgment,
  truncateReadPreview,
  selectReceiptFallbackReply,
};