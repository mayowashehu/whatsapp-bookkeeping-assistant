/**
 * Fallback messaging for receipt-photo specific failures — missing media,
 * unsupported/corrupted image, and reading failures.
 *
 * Mirrors transcription/transcriptionFallback.js's split for the same
 * reason: "is the AI provider temporarily unavailable?" (rate limited,
 * model missing, provider overloaded — retry the exact same photo) is a
 * different situation from "is something wrong with the photo itself?"
 * (corrupted file, unsupported format, too dark/blurry to read — the fix
 * is a different photo or typing the transaction instead), and the user
 * should get guidance that matches which one actually happened.
 */

export const RECEIPT_PROCESSING_FALLBACK_MESSAGE =
  "⚠️ *Couldn't Process Photo*\n\nI couldn't process that photo.\n\n_Please try again with a clearer photo, or send the transaction as text._";

// Distinct from the generic fallback above: this is the "I read the photo
// fine, but I'm not confident enough about the amount to draft anything"
// case — the vision model's own UNREADABLE response (see
// GeminiReceiptService.js), not a technical failure. Never silently guesses
// an amount here; asks the user to confirm one instead.
export const RECEIPT_UNREADABLE_MESSAGE =
  '📸 *Couldn\'t Read That Receipt*\n\nI couldn\u2019t confidently read an amount off that photo — it might be blurry, cropped, or not a receipt.\n\n_Try a clearer photo, or type the transaction instead — e.g. *Paid 15,000 for diesel at Flat 2*._';

// Failures caused by the photo itself (missing, corrupted, unsupported
// format) or by the download step that feeds it. Retrying the identical
// photo will not help.
export const RECEIPT_PROCESSING_ERROR_CODES = Object.freeze([
  'UNSUPPORTED_IMAGE',
  'MEDIA_DOWNLOAD_INVALID_INPUT',
  'MEDIA_DOWNLOAD_FAILED',
  'MEDIA_DOWNLOAD_INVALID_RESPONSE',
  'MEDIA_DOWNLOAD_TIMEOUT',
  'MEDIA_TEMP_WRITE_FAILED',
  'RECEIPT_READ_FAILED',
  'RECEIPT_INVALID_INPUT',
  'RECEIPT_INVALID_RESPONSE',
  'RECEIPT_BAD_IMAGE',
  'RECEIPT_TIMEOUT',
]);

// Failures on our side or the provider's side (missing API key, auth
// errors, transient provider errors) that have nothing to do with the
// specific photo. These use the same "system busy" messaging as other
// AI-unavailable errors, since a different photo would not help.
export const RECEIPT_SERVICE_BUSY_CODES = Object.freeze([
  'RECEIPT_CONFIG_ERROR',
  'RECEIPT_PROVIDER_ERROR',
  'RECEIPT_REQUEST_FAILED',
  'MEDIA_DOWNLOAD_CONFIG_ERROR',
]);

export function isReceiptProcessingError(err) {
  return RECEIPT_PROCESSING_ERROR_CODES.includes(err?.code);
}

export function isReceiptServiceBusyError(err) {
  return RECEIPT_SERVICE_BUSY_CODES.includes(err?.code);
}

export default {
  RECEIPT_PROCESSING_FALLBACK_MESSAGE,
  RECEIPT_UNREADABLE_MESSAGE,
  RECEIPT_PROCESSING_ERROR_CODES,
  RECEIPT_SERVICE_BUSY_CODES,
  isReceiptProcessingError,
  isReceiptServiceBusyError,
};