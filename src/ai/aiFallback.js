/**
 * Shared fallback when Gemini / AI Studio is unavailable (429, 404, etc.).
 */
export const AI_BUSY_FALLBACK_MESSAGE =
  "The assistant is busy right now. I can still help if you resend the message in a moment.";

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
