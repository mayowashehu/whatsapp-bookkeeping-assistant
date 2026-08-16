/**
 * Safe user-facing fallback when processing fails unexpectedly.
 * Must not include internal error details.
 */
export const SAFE_WHATSAPP_FALLBACK_REPLY =
  '⚠️ *Something Went Wrong*\n\nSorry, something went wrong on my side.\n\n_Please try again in a moment._';

/**
 * Used specifically when the WhatsApp send itself failed (Meta API error,
 * network issue, timeout) rather than a generic internal processing error.
 * Kept distinct from SAFE_WHATSAPP_FALLBACK_REPLY so logs/behavior can tell
 * the two failure modes apart, and so the retry attempt communicates the
 * right thing if it does get through.
 */
export const SEND_FAILURE_FALLBACK_REPLY =
  "⚠️ *Message Not Sent*\n\nI couldn't send that reply just now.\n\n_Please try again in a moment._";

export default {
  SAFE_WHATSAPP_FALLBACK_REPLY,
  SEND_FAILURE_FALLBACK_REPLY,
};
