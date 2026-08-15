/**
 * src/services/textPreFilter.js
 *
 * Fast-pass for messages that should never hit the LLM.
 * Greetings are intentionally excluded — messageHandlerShared.js handles
 * them with the full welcome flow (new-user detection, draft context, etc.).
 */

// Keywords that indicate a clarification turn or action
const CLARIFICATION_KEYWORDS = /\b(rename|create|save|yes|no|use|call|set|option|apartment|property|orchid)\b/i;

/**
 * Checks if a message can skip the full processing pipeline.
 */
export function checkFastPassIntent(text) {
  const clean = String(text || '').trim();

  // If text contains any clarification keywords, bypass fast-pass immediately
  if (CLARIFICATION_KEYWORDS.test(clean)) {
    return { isFastPass: false };
  }

  return { isFastPass: false };
}

export default {
  checkFastPassIntent,
};