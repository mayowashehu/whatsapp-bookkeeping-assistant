
/**
 * User-isolated message debouncing for WhatsApp webhook.
 * Buffers messages from the same sender for 4 seconds, then processes them as a single batch.
 * Prevents rapid-fire texting from exhausting Gemini API quotas.
 */
const userBuffers = new Map(); // key: senderId, value: { messages: string[], timer, onComplete }
const DEBOUNCE_MS = 4000; // 4 seconds per user

function flush(senderId) {
  const buffer = userBuffers.get(senderId);
  if (!buffer) return Promise.resolve();

  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  userBuffers.delete(senderId);

  const concatenatedText = buffer.messages.join(' ').trim();
  if (concatenatedText && typeof buffer.onComplete === 'function') {
    return Promise.resolve(buffer.onComplete(concatenatedText));
  }
  return Promise.resolve();
}

/**
 * Debounces incoming messages per senderId.
 *
 * @param {string} senderId - WhatsApp sender ID (phone number)
 * @param {string} text - Text content of the message
 * @param {function} onDebounceComplete - Callback function called when debounce timer expires
 *   Receives the concatenated text buffer as argument
 * @param {object} [options]
 * @param {(text: string) => boolean} [options.isBoundary] - Identifies a message that is a
 *   complete, decisive turn on its own (e.g. "yes", "cancel", "no"). When a message like this
 *   arrives, two things happen: (1) whatever was already buffered is flushed immediately as its
 *   own turn instead of being glued onto this one — "paid 10k" and "yes" are different turns,
 *   not fragments of the same sentence — and (2) this message itself is flushed right away
 *   rather than waiting out the full debounce window, since a decisive one-word command doesn't
 *   need more fragments to be complete. Without this, rapid-fire "paid 10k" / "yes" / "cancel"
 *   collapse into one nonsensical concatenated string.
 */
export function debounceMessage(senderId, text, onDebounceComplete, options = {}) {
  if (!senderId || !onDebounceComplete) {
    return;
  }

  const { isBoundary } = options;
  const isBoundaryMessage = typeof isBoundary === 'function' && isBoundary(text);

  const existing = userBuffers.get(senderId);
  if (existing && isBoundaryMessage) {
    flush(senderId);
  }

  if (!userBuffers.has(senderId)) {
    userBuffers.set(senderId, { messages: [], timer: null, onComplete: onDebounceComplete });
  }
  const buffer = userBuffers.get(senderId);
  buffer.onComplete = onDebounceComplete;
  buffer.messages.push(text);

  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }

  const delay = isBoundaryMessage ? 0 : DEBOUNCE_MS;
  buffer.timer = setTimeout(() => flush(senderId), delay);
}

/**
 * Immediately flushes any buffered text for a sender, bypassing the debounce
 * window. Exposed mainly for tests and for callers that need deterministic
 * control over when a buffered turn fires.
 */
export function flushDebounce(senderId) {
  return flush(senderId);
}

/**
 * True if a sender currently has buffered (not yet flushed) text waiting.
 * Exposed mainly for tests that need to wait for a debounce registration
 * before deterministically forcing a flush.
 */
export function hasPendingBuffer(senderId) {
  return userBuffers.has(senderId);
}

export default { debounceMessage, flushDebounce, hasPendingBuffer };
