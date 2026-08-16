import { logInternalError, logProcessingEvent } from '../../utils/safeLog.js';
import { AI_BUSY_FALLBACK_MESSAGE, isAiUnavailableError } from '../../ai/aiFallback.js';
import {
  AUDIO_PROCESSING_FALLBACK_MESSAGE,
  isAudioProcessingError,
  isTranscriptionServiceBusyError,
} from '../../transcription/transcriptionFallback.js';
import { createTranscriptionService } from '../../transcription/createTranscriptionService.js';
import { deleteTempAudioFile, downloadWhatsAppMedia } from './mediaDownload.service.js';
import { SAFE_WHATSAPP_FALLBACK_REPLY, SEND_FAILURE_FALLBACK_REPLY } from './safeReply.js';
import { sendWhatsAppText } from './whatsappSend.service.js';
import { processMessageContent } from './messageHandlerShared.js';
import { checkFastPassIntent } from '../../services/textPreFilter.js';

// Voice notes are transcribed by an AI model that can mishear names,
// amounts, or numbers — especially over noisy connections. Rather than
// silently acting on whatever text came back, every successful transcript
// is echoed back to the user alongside the bot's reply so they can catch a
// bad transcription before it turns into a bad bookkeeping entry.
const HEARD_PREVIEW_MAX_LENGTH = 300;

/**
 * Truncates a long transcript for the "I heard" preview so a single rambling
 * voice note doesn't turn into a wall of text before the actual reply.
 */
export function truncateHeardPreview(text, maxLength = HEARD_PREVIEW_MAX_LENGTH) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trim()}…`;
}

/**
 * Prepends a short "I heard: ..." acknowledgment of the transcribed audio
 * ahead of the bot's actual reply, so the user can sanity-check a noisy
 * transcription. Returns replyText unchanged if there's no transcript to
 * show (defensive — the transcription service should never return empty
 * text, but this must never crash the reply path if it does).
 */
export function prependTranscriptAcknowledgment(transcribedText, replyText) {
  const trimmed = String(transcribedText || '').trim();
  if (!trimmed) {
    return replyText;
  }
  const preview = truncateHeardPreview(trimmed);
  return `🎙️ _I heard: "${preview}"_\n\n${replyText}`;
}

/**
 * Chooses the safest, most useful fallback reply for a failure that
 * happened anywhere in the voice pipeline (download, validation,
 * transcription, or downstream processing).
 */
export function selectVoiceFallbackReply(err) {
  if (isAiUnavailableError(err) || isTranscriptionServiceBusyError(err)) {
    return AI_BUSY_FALLBACK_MESSAGE;
  }
  if (isAudioProcessingError(err)) {
    return AUDIO_PROCESSING_FALLBACK_MESSAGE;
  }
  return SAFE_WHATSAPP_FALLBACK_REPLY;
}

function createDefaultDeps() {
  return {
    downloadWhatsAppMedia,
    deleteTempAudioFile,
    createTranscriptionService,
    checkFastPassIntent,
    processMessageContent,
    sendWhatsAppText,
    logInternalError,
    logProcessingEvent,
  };
}

/**
 * Builds a voice message handler with injectable dependencies. Production
 * code uses the default export below; tests can pass in fakes for the
 * media/transcription/send layers to simulate full requests without any
 * network or database access.
 */
export function createVoiceMessageHandler(overrides = {}) {
  const deps = { ...createDefaultDeps(), ...overrides };

  /**
   * Thin WhatsApp voice handler — always replies; never logs transcript text.
   */
  async function handleVoiceMessage(message) {
    const mediaId = message?.audio?.id;
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
          'VoiceMessageService',
          new Error('Missing audio media id'),
          { messageId, senderId: fromNumber },
        );
        await deps.sendWhatsAppText(fromNumber, AUDIO_PROCESSING_FALLBACK_MESSAGE);
        deps.logProcessingEvent('VoiceMessageService', {
          messageId,
          intent,
          status: 'fallback_sent',
          durationMs: Date.now() - startedAt,
          senderId: fromNumber,
        });
        return;
      }

      const downloaded = await deps.downloadWhatsAppMedia(mediaId, {
        mimeType: message.audio?.mimeType,
      });
      tempFilePath = downloaded.filePath;

      const transcriptionService = deps.createTranscriptionService();
      const transcript = await transcriptionService.transcribe({
        filePath: downloaded.filePath,
        mimeType: downloaded.mimeType,
      });

      const transcribedText = transcript?.text || '';

      // Fast-pass check on transcribed voice text
      const fastPass = deps.checkFastPassIntent(transcribedText);
      let replyText;
      let acknowledgeTranscript = false;

      if (fastPass.isFastPass) {
        intent = fastPass.intent;
        replyText = fastPass.replyText;
        acknowledgeTranscript = true;
      } else {
        const result = await deps.processMessageContent({
          content: transcribedText,
          fromNumber,
        });
        if (result?.replyText) {
          replyText = result.replyText;
          acknowledgeTranscript = true;
        } else {
          replyText = SAFE_WHATSAPP_FALLBACK_REPLY;
          status = 'fallback_no_result';
        }
      }

      if (acknowledgeTranscript) {
        replyText = prependTranscriptAcknowledgment(transcribedText, replyText);
      }

      const sendResult = await deps.sendWhatsAppText(fromNumber, replyText);
      if (!sendResult.success) {
        status = 'send_failed';
        deps.logInternalError(
          'VoiceMessageService',
          new Error(sendResult.error?.message || 'Send failed'),
          { messageId, senderId: fromNumber },
        );

        const retryResult = await deps.sendWhatsAppText(fromNumber, SEND_FAILURE_FALLBACK_REPLY);
        status = retryResult.success ? 'send_failed_retry_ok' : 'send_failed_retry_failed';
        if (!retryResult.success) {
          deps.logInternalError(
            'VoiceMessageService',
            new Error(retryResult.error?.message || 'Retry send failed'),
            { messageId, senderId: fromNumber },
          );
        }
      }

      deps.logProcessingEvent('VoiceMessageService', {
        messageId,
        intent,
        status,
        durationMs: Date.now() - startedAt,
        senderId: fromNumber,
      });
    } catch (err) {
      status = 'error';
      deps.logInternalError('VoiceMessageService', err, { messageId, senderId: fromNumber });

      try {
        const fallback = selectVoiceFallbackReply(err);
        const fallbackResult = await deps.sendWhatsAppText(fromNumber, fallback);
        status = fallbackResult.success ? 'fallback_sent' : 'fallback_send_failed';
      } catch (sendErr) {
        deps.logInternalError('VoiceMessageService', sendErr, {
          messageId,
          senderId: fromNumber,
        });
        status = 'fallback_send_failed';
      }

      deps.logProcessingEvent('VoiceMessageService', {
        messageId,
        intent,
        status,
        durationMs: Date.now() - startedAt,
        senderId: fromNumber,
      });
    } finally {
      await deps.deleteTempAudioFile(tempFilePath);
    }
  }

  return { handleVoiceMessage };
}

const defaultHandler = createVoiceMessageHandler();

export const handleVoiceMessage = defaultHandler.handleVoiceMessage;

export default {
  handleVoiceMessage,
  createVoiceMessageHandler,
  prependTranscriptAcknowledgment,
  truncateHeardPreview,
  selectVoiceFallbackReply,
};
