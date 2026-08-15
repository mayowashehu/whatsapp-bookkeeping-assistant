import { logInternalError, logProcessingEvent } from '../../utils/safeLog.js';
import { SAFE_WHATSAPP_FALLBACK_REPLY, SEND_FAILURE_FALLBACK_REPLY } from './safeReply.js';
import { sendWhatsAppText } from './whatsappSend.service.js';
import { processMessageContent, isCancelCommand, isConfirmationWord, isNegativeConfirmationWord } from './messageHandlerShared.js';
import { debounceMessage } from '../../utils/messageDebouncer.js';
import { checkFastPassIntent } from '../../services/textPreFilter.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalize.js';
import { isLocked, withSenderLock } from '../../utils/concurrencyLocks.js';

const STILL_PROCESSING_REPLY =
  "I'm still processing your previous message. Please wait a moment.";

/**
 * A message that is a complete, decisive turn on its own — "yes", "cancel",
 * "no" — rather than a fragment of a longer thought. Used by the debouncer
 * so rapid-fire "paid 10k" / "yes" / "cancel" are treated as three separate
 * turns, processed in order, instead of being concatenated into one
 * nonsensical string (stress-scenario T).
 */
function isBoundaryMessage(text) {
  return isCancelCommand(text) || isConfirmationWord(text) || isNegativeConfirmationWord(text);
}

/**
 * Thin WhatsApp text handler — classifies, delegates, always replies, with debouncing.
 */
export async function handleTextMessage(message) {
  const messageId = message?.messageId;
  const text = message?.text;
  const fromNumber = message?.senderId || message?.phoneNumber;
  const startedAt = Date.now();

  // Use debouncer to buffer rapid-fire texts from the same user. Boundary
  // commands (yes/no/cancel) flush immediately as their own turn instead of
  // waiting out the full window or being glued onto whatever preceded them.
  debounceMessage(fromNumber, text, async (concatenatedText) => {
    // The lock below serializes actual processing per sender, but debounce
    // callbacks fire independently of it (each is its own async task), so a
    // slow AI call on one turn can still overlap with the next turn's
    // callback firing before the first is done. Surface that to the user
    // instead of leaving them wondering why nothing happened yet — the
    // message itself still gets processed once its turn comes, via the
    // lock queue below.
    if (isLocked(fromNumber)) {
      try {
        await sendWhatsAppText(fromNumber, STILL_PROCESSING_REPLY);
      } catch (notifyErr) {
        logInternalError('TextMessageService', notifyErr, { senderId: fromNumber });
      }
    }

    await withSenderLock(fromNumber, async () => {
      let intent = 'none';
      let status = 'ok';
      const debounceStartedAt = Date.now();

      try {
        // 1. FAST-PASS CHECK: Intercept non-financial text before hitting LLM
        const fastPass = checkFastPassIntent(concatenatedText);
        let replyText;

        if (fastPass.isFastPass) {
          intent = fastPass.intent;
          replyText = fastPass.replyText;
        } else {
          const result = await processMessageContent({
            content: concatenatedText,
            fromNumber,
          });
          replyText = result?.replyText || SAFE_WHATSAPP_FALLBACK_REPLY;
          intent = result?.classification || intent;
          if (!result?.replyText) {
            status = 'fallback_no_result';
          }
        }

        const sendResult = await sendWhatsAppText(fromNumber, replyText);
        if (!sendResult.success) {
          status = 'send_failed';
          logInternalError(
            'TextMessageService',
            new Error(sendResult.error?.message || 'Send failed'),
            { senderId: fromNumber },
          );

          // Don't pretend the reply went out. Attempt one recovery send with
          // delivery-specific copy, and record whether THAT attempt actually
          // succeeded rather than assuming it did.
          const retryResult = await sendWhatsAppText(fromNumber, SEND_FAILURE_FALLBACK_REPLY);
          status = retryResult.success ? 'send_failed_retry_ok' : 'send_failed_retry_failed';
          if (!retryResult.success) {
            logInternalError(
              'TextMessageService',
              new Error(retryResult.error?.message || 'Retry send failed'),
              { senderId: fromNumber },
            );
          }
        }

        logProcessingEvent('TextMessageService', {
          messageId,
          intent,
          status,
          durationMs: Date.now() - debounceStartedAt,
          senderId: fromNumber,
        });
      } catch (err) {
        status = 'error';
        logInternalError('TextMessageService', err, { senderId: fromNumber });

        try {
          const fallbackResult = await sendWhatsAppText(fromNumber, SAFE_WHATSAPP_FALLBACK_REPLY);
          status = fallbackResult.success ? 'fallback_sent' : 'fallback_send_failed';
        } catch (sendErr) {
          logInternalError('TextMessageService', sendErr, {
            senderId: fromNumber,
          });
          status = 'fallback_send_failed';
        }

        logProcessingEvent('TextMessageService', {
          messageId,
          intent,
          status,
          durationMs: Date.now() - debounceStartedAt,
          senderId: fromNumber,
        });
      }
    });
  }, { isBoundary: isBoundaryMessage });

  // Log the individual message receipt
  logProcessingEvent('TextMessageService', {
    messageId,
    intent: 'buffered',
    status: 'ok',
    durationMs: Date.now() - startedAt,
    senderId: fromNumber,
  });
}

export default {
  handleTextMessage,
};
