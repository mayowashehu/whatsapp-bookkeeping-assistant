import { normalizeMessage } from './webhookPayload.service.js';
import { routeMessage } from './MessageRouter.js';
import { truncateSenderId } from '../../utils/safeLog.js';
import { markMessageProcessed } from '../../services/MessageIdService.js';
import { markMessageAsRead, sendWhatsAppText } from './whatsappSend.service.js';
import { acquireLock } from '../../utils/concurrencyLocks.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalize.js'; // VULNERABILITY FIX: Import canonical normalizer
import { card } from '../../utils/waFormat.js';

// BUG FIX (live, confirmed): Meta's WhatsApp typing indicator auto-expires
// after 25 seconds — it is NOT a toggle that stays on until you explicitly
// turn it off. The single markMessageAsRead call below only fired once, at
// the very start of the pipeline, before any AI/DB work even began. On a
// fast reply this was invisible (indicator showed, reply arrived well
// under 25s, indicator auto-dismissed on send — looked fine). On a slower
// one — a Gemini call that's briefly rate-limited, a fallback-model retry,
// a slow DB round trip — processing can run past 25 seconds, at which
// point WhatsApp silently drops the indicator on its own with no way for
// us to know it happened. The user then sees total silence for however
// much longer the request takes, even though the bot is still actively
// working. This is exactly the intermittent "sometimes it just goes quiet"
// behavior reported.
//
// Fix: re-issue the typing indicator on an interval for as long as
// processing is still running, comfortably inside the 25s window (chosen
// well under it so a slow event loop tick can never let one lapse), and
// stop the instant the real reply is sent (routeMessage settles) or the
// pipeline errors out. A resend failure here is logged and swallowed —
// it must never be allowed to fail the actual message processing.
const TYPING_INDICATOR_REFRESH_MS = 18000;

function startTypingIndicatorKeepAlive(messageId) {
  const timer = setInterval(() => {
    markMessageAsRead(messageId, { showTyping: true }).catch((err) => {
      console.warn(
        `[processMessagePipeline] Typing indicator refresh failed messageId=${messageId}`,
        err,
      );
    });
  }, TYPING_INDICATOR_REFRESH_MS);
  // Never let this interval itself keep the Node process alive.
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export async function processMessagePipeline(message, fullPayload) {
  if (!message || typeof message !== 'object') {
    console.warn('[processMessagePipeline] Invalid or missing message object received.');
    return;
  }

  // VULNERABILITY FIX: Normalize phone number immediately to ensure uniform canonical format
  const rawPhoneNumber = message.from ? String(message.from) : null;
  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  
  if (!phoneNumber) {
    console.warn('[processMessagePipeline] Missing or invalid sender phone number (message.from). Cannot proceed.');
    return;
  }

  // Pure in-memory normalization to extract canonical senderId before acquiring lock
  const contacts = Array.isArray(fullPayload?.contacts) ? fullPayload.contacts : [];
  const normalized = normalizeMessage(message, contacts, message);
  
  // Ensure the message envelope's identifiers strictly use the canonical normalized number
  normalized.senderId = normalizePhoneNumber(normalized.senderId || phoneNumber);
  const senderId = normalized.senderId;

  // Acquire per-user lock at the absolute entry point using the canonical normalized senderId
  const releaseLock = await acquireLock(senderId);

  try {
    // Dedup FIRST, before any outbound WhatsApp send. Meta redelivers
    // webhooks automatically when it doesn't get a fast enough 200 OK, so a
    // duplicate messageId here is almost always an automatic retry, not a
    // second message from the user. Checking dedup before the read-receipt/
    // typing-indicator ack means a retry is a true no-op — previously an
    // ack fired unconditionally up front, so every automatic retry
    // produced a second, confusing ack even though only one reply was ever
    // actually generated.
    const inserted = await markMessageProcessed(
      normalized.messageId,
      senderId,
    );

    if (!inserted) {
      console.log(
        `[processMessagePipeline] Duplicate message ignored messageId=${normalized.messageId}`,
      );
      return;
    }

    // FIX (Phase 1.6, 🔴 — confirmed live): this used to send a throwaway
    // "Got it, processing your request..." text message, THEN separately
    // call markMessageAsRead — two sequential Meta API round trips before
    // any AI/DB work even started. Replaced with a single combined
    // read-receipt + native-typing-indicator call (see
    // MetaApiClient.js/whatsappSend.service.js) — one HTTP round trip
    // instead of two, and it renders as WhatsApp's own "typing…" animation
    // rather than a text bubble the user has to read and dismiss. It's
    // auto-dismissed the moment routeMessage below sends the real reply.
    let stopTypingKeepAlive = () => {};
    try {
      await markMessageAsRead(normalized.messageId, { showTyping: true });
      // BUG FIX (live, confirmed): see startTypingIndicatorKeepAlive above —
      // without this, the indicator silently expired after 25s on any
      // slower request, leaving the user staring at total silence while the
      // bot was still working. Only start the keep-alive once the initial
      // call actually succeeded — no point refreshing an indicator that
      // never showed in the first place.
      stopTypingKeepAlive = startTypingIndicatorKeepAlive(normalized.messageId);
    } catch (readErr) {
      console.warn(
        `[processMessagePipeline] Failed to mark message as read / show typing indicator messageId=${normalized.messageId}`,
        readErr,
      );
    }

    logSafeMessageSummary(normalized);

    try {
      await routeMessage(normalized);
    } finally {
      // Stop refreshing the instant we're done, success or failure — no
      // point re-showing "typing…" after the real reply already went out.
      stopTypingKeepAlive();
    }
  } catch (error) {
    console.error('[PIPELINE ERROR] Failed to process request:', error);

    try {
      await sendWhatsAppText(
        phoneNumber,
        card('⚠️', 'System Error', ['A system error occurred while generating the document.'], 'Please verify your inputs and try again.'),
      );
    } catch (fallbackErr) {
      console.error('[PIPELINE FATAL] Fallback text send also failed:', fallbackErr);
    }
  } finally {
    // Always release the lock for this sender, regardless of pipeline success or failure
    await releaseLock();
  }
}

export function receiveWebhook(payload) {
  const messages = extractIncomingMessagesFromPayload(payload);

  if (messages.length === 0) {
    console.log('[WhatsAppWebhook] No inbound messages (status/update only) — acknowledging');
    return { accepted: true, messageCount: 0 };
  }

  console.log(`[WhatsAppWebhook] Accepted ${messages.length} message(s) for async routing`);

  for (const item of messages) {
    setImmediate(async () => {
      try {
        await processMessagePipeline(item.message, item.fullPayload);
      } catch (err) {
        console.error(
          `[WhatsAppWebhook] Error processing messageId=${item.message?.id}`,
          err,
        );
      }
    });
  }

  return { accepted: true, messageCount: messages.length };
}

function extractIncomingMessagesFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entry)) {
    return [];
  }

  const collected = [];

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value || typeof value !== 'object') {
        continue;
      }
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        collected.push({ message, fullPayload: value });
      }
    }
  }

  return collected;
}

function logSafeMessageSummary(message) {
  const parts = [
    `type=${message.messageType}`,
    `messageId=${message.messageId}`,
    `sender=${truncateSenderId(message.senderId)}`,
  ];

  if (message.messageType === 'text') {
    parts.push(`textLength=${message.text?.length ?? 0}`);
  }

  if (message.messageType === 'audio') {
    parts.push(`hasMedia=${Boolean(message.audio?.id)}`);
    parts.push(`voice=${Boolean(message.audio?.voice)}`);
  }

  // FIX (3.1): parity with the audio branch above — without this, every
  // inbound receipt photo logged with no branch at all (harmless, but
  // silently less informative than every other supported type).
  if (message.messageType === 'image') {
    parts.push(`hasMedia=${Boolean(message.image?.id)}`);
    parts.push(`hasCaption=${Boolean(message.image?.caption)}`);
  }

  if (message.messageType === 'unsupported') {
    parts.push(`unsupportedType=${message.unsupportedType ?? 'unknown'}`);
  }

  console.log(`[processMessagePipeline] ${parts.join(' ')}`);
}

export default {
  processMessagePipeline,
  receiveWebhook,
};