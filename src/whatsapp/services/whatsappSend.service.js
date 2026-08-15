import { createMetaApiClient } from '../meta/MetaApiClient.js';
import { normalizeWhatsAppPhoneNumber } from '../delivery/phoneNumber.js';

/**
 * Sends a plain-text WhatsApp Cloud API message via the shared MetaApiClient pipeline.
 * Returns { success, data, error } — does not throw for operational failures.
 */
export async function sendWhatsAppText(to, body, deps = {}) {
  const metaClient = deps.metaClient || createMetaApiClient();
  console.log(`[whatsappSend] Sending text to=${to} body=${String(body).slice(0, 50)}...`);

  if (!body || !String(body).trim()) {
    return {
      success: false,
      data: null,
      error: {
        code: 'INVALID_MESSAGE',
        message: 'Message body is required',
      },
    };
  }

  const phone = normalizeWhatsAppPhoneNumber(to);
  if (!phone.ok) {
    return {
      success: false,
      data: null,
      error: phone.error,
    };
  }

  const result = await metaClient.sendMessage({
    messaging_product: 'whatsapp',
    to: phone.phoneNumber,
    type: 'text',
    text: {
      preview_url: false,
      body: String(body),
    },
  });

  if (!result.success) {
    console.error(
      `[whatsappSend] Send failure code=${result.error?.code} message=${result.error?.message}`,
    );
    
    return result;
  }
  const messageId = result.data?.messages?.[0]?.id || null;
  console.log(`[whatsappSend] Send success messageId=${messageId}`);

  return {
    success: true,
    data: {
      messageId,
    },
    error: null,
  };
}

/**
 * Marks an incoming WhatsApp message as read via Meta Cloud API. Pass
 * `{ showTyping: true }` to also raise the native WhatsApp typing
 * indicator in the same API call (see MetaApiClient.js's markMessageAsRead
 * for why this replaced a separate throwaway text-message ack).
 * Returns { success, data, error } — does not throw for operational failures.
 */
export async function markMessageAsRead(messageId, deps = {}) {
  const { metaClient: metaClientOverride, showTyping = false } = deps;
  const metaClient = metaClientOverride || createMetaApiClient();

  if (!messageId || !String(messageId).trim()) {
    return {
      success: false,
      data: null,
      error: {
        code: 'INVALID_MESSAGE_ID',
        message: 'messageId is required',
      },
    };
  }

  const result = await metaClient.markMessageAsRead(String(messageId), { showTyping });

  if (!result.success) {
    console.warn(
      `[whatsappSend] Mark as read failure code=${result.error?.code} message=${result.error?.message}`,
    );
  }

  return result;
}

export default {
  sendWhatsAppText,
  markMessageAsRead,
};
