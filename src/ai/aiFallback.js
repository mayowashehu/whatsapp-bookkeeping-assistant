/**
 * Shared fallback when Gemini / AI Studio is unavailable (429, 404, etc.).
 */
export const AI_BUSY_FALLBACK_MESSAGE =
  "⚠️ *Assistant Busy*\n\nI'm briefly overloaded and couldn't process that.\n\n_Please resend your message in a moment._";

export const AI_UNAVAILABLE_CODES = Object.freeze([
  'AI_RATE_LIMIT',
  'AI_MODEL_NOT_FOUND',
  'AI_UNAVAILABLE',
  'AI_TIMEOUT',
  'AI_PROVIDER_OVERLOADED',
  'AI_PROVIDER_ERROR',
  'AI_REQUEST_FAILED',
]);

export function isAiUnavailableError(err) {
  return AI_UNAVAILABLE_CODES.includes(err?.code);
}

export default {
  AI_BUSY_FALLBACK_MESSAGE,
  AI_UNAVAILABLE_CODES,
  isAiUnavailableError,
};
