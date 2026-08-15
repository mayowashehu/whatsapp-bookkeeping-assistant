/**
 * Supported inbound WhatsApp message types for v0.1.
 */
export const SUPPORTED_MESSAGE_TYPES = Object.freeze(['text', 'audio', 'image']);

/**
 * Extracts and normalizes inbound WhatsApp Cloud API messages.
 * Does not call AI, DB, or outbound WhatsApp APIs.
 *
 * @returns {Array<object>} Normalized message envelopes (may be empty for status-only webhooks).
 */
export function extractIncomingMessages(payload) {
  if (!payload || typeof payload !== 'object') {
    const error = new Error('Webhook payload must be a JSON object');
    error.statusCode = 400;
    throw error;
  }

  if (payload.object !== 'whatsapp_business_account') {
    const error = new Error('Unexpected webhook object type');
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(payload.entry)) {
    const error = new Error('Webhook payload missing entry array');
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value;

      if (!value || typeof value !== 'object') {
        continue;
      }

      // Status delivery receipts have no messages — acknowledge silently upstream.
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      for (const message of messages) {
        normalized.push(normalizeMessage(message, contacts, message));
      }
    }
  }

  return normalized;
}

export function normalizeMessage(message, contacts, rawMessage) {
  const senderId = message?.from ? String(message.from) : null;
  const contact = contacts.find((item) => item?.wa_id && String(item.wa_id) === senderId);
  const phoneNumber = contact?.wa_id ? String(contact.wa_id) : senderId;

  const base = {
    senderId,
    phoneNumber,
    messageId: message?.id ? String(message.id) : null,
    timestamp: message?.timestamp ? String(message.timestamp) : null,
    messageType: null,
    text: null,
    audio: null,
    image: null,
    rawPayload: rawMessage,
  };

  if (!senderId || !base.messageId) {
    return {
      ...base,
      messageType: 'unsupported',
    };
  }

  const type = message?.type;

  if (type === 'text' && message.text?.body) {
    return {
      ...base,
      messageType: 'text',
      text: String(message.text.body),
    };
  }

  if (type === 'audio' && message.audio?.id) {
    return {
      ...base,
      messageType: 'audio',
      audio: {
        id: String(message.audio.id),
        mimeType: message.audio.mime_type ? String(message.audio.mime_type) : null,
        sha256: message.audio.sha256 ? String(message.audio.sha256) : null,
        voice: Boolean(message.audio.voice),
      },
    };
  }

  // FIX (3.1): extends the exact pattern already used for audio above — a
  // property manager photographing a receipt is completely normal use of
  // this product, and it previously fell straight into 'unsupported'.
  // Caption is deliberately captured: a user photographing a receipt very
  // plausibly types "Flat 2" as the caption, which is far more reliable
  // property context than anything the vision model could ever read off
  // the receipt itself — see ReceiptMessageService.js / GeminiReceiptService.js.
  if (type === 'image' && message.image?.id) {
    return {
      ...base,
      messageType: 'image',
      image: {
        id: String(message.image.id),
        mimeType: message.image.mime_type ? String(message.image.mime_type) : null,
        sha256: message.image.sha256 ? String(message.image.sha256) : null,
        caption: message.image.caption ? String(message.image.caption) : null,
      },
    };
  }

  return {
    ...base,
    messageType: 'unsupported',
    unsupportedType: type ? String(type) : 'unknown',
  };
}

export default {
  SUPPORTED_MESSAGE_TYPES,
  extractIncomingMessages,
  normalizeMessage,
};