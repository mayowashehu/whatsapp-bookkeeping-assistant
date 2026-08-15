import * as TextMessageService from './TextMessageService.js';
import * as VoiceMessageService from './VoiceMessageService.js';
import * as ReceiptMessageService from './ReceiptMessageService.js';
import { logInternalError, logProcessingEvent, truncateSenderId } from '../../utils/safeLog.js';
import { SAFE_WHATSAPP_FALLBACK_REPLY } from './safeReply.js';
import { sendWhatsAppText } from './whatsappSend.service.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalize.js'; // VULNERABILITY FIX

// FIX (3.1): now that images are a supported, routed type (see handlers
// below), this copy needs to say so — the old wording actively told people
// photos weren't supported right as we started accepting them.
const UNSUPPORTED_MEDIA_REPLY =
  'I currently support text messages, voice notes, and receipt photos. Please send your bookkeeping request as text, a voice note, or a photo of a receipt.';

const handlers = {
  text: TextMessageService.handleTextMessage,
  audio: VoiceMessageService.handleVoiceMessage,
  image: ReceiptMessageService.handleReceiptMessage,
};

export async function routeMessage(message) {
  const type = message?.messageType;
  const messageId = message?.messageId;
  
  // VULNERABILITY FIX: Standardize sender identifier retrieval with normalization
  const rawSenderId = message?.senderId || message?.phoneNumber;
  const senderId = normalizePhoneNumber(rawSenderId);
  const startedAt = Date.now();

  if (type === 'unsupported') {
    logProcessingEvent('MessageRouter', {
      messageId,
      intent: 'unsupported',
      status: 'unsupported',
      durationMs: Date.now() - startedAt,
      senderId,
      detail: `type=${message.unsupportedType ?? 'unknown'}`,
    });

    try {
      await sendWhatsAppText(senderId, UNSUPPORTED_MEDIA_REPLY);
    } catch (err) {
      logInternalError('MessageRouter', err, {
        messageId,
        senderId,
      });
    }

    return;
  }

  const handler = handlers[type];

  if (!handler) {
    logProcessingEvent('MessageRouter', {
      messageId,
      intent: 'none',
      status: 'no_handler',
      durationMs: Date.now() - startedAt,
      senderId,
      detail: `type=${type}`,
    });
    await sendSafeFallback(senderId, messageId);
    return;
  }

  console.log(
    `[MessageRouter] Routing type=${type} messageId=${messageId} sender=${truncateSenderId(senderId)}`,
  );

  // Inject normalized senderId back into message payload to safeguard downstream consumers
  message.senderId = senderId;
  await handler(message);
}

async function sendSafeFallback(senderId, messageId) {
  try {
    await sendWhatsAppText(senderId, SAFE_WHATSAPP_FALLBACK_REPLY);
  } catch (err) {
    logInternalError('MessageRouter', err, { messageId, senderId });
  }
}

export function registerHandler(messageType, handler) {
  if (typeof messageType !== 'string' || typeof handler !== 'function') {
    throw new Error('registerHandler requires a messageType string and handler function');
  }
  handlers[messageType] = handler;
}

export default {
  routeMessage,
  registerHandler,
};