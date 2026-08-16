/**
 * User-isolated message debouncing for WhatsApp webhook.
 * Buffers messages from the same sender, then processes them as a single
 * batch once the sender appears to be done typing. Prevents rapid-fire
 * texting from exhausting Gemini API quotas, and stops mid-thought
 * fragments ("paid 10k" then "for flat 2") from being processed as two
 * broken messages instead of one real transaction.
 */
const userBuffers = new Map(); // key: senderId, value: { messages: string[], timer, onComplete }
const DEBOUNCE_MS = 4000; // full wait for anything that might still be a fragment

// PERF FIX: the full 4s wait exists to protect genuinely incomplete
// fragments (see module docstring), but it was being applied uniformly to
// every message — including ones that already read as a complete, finished
// thought on their own, like a full "Paid 15,000 for diesel at Flat 2" sent
// in one go, or any message the sender visibly ended with a period. Those
// don't need four seconds of "might they still be typing?" margin — a
// short window is still kept (rather than 0) purely to absorb the case of
// someone firing off a real, instant follow-up a beat later (e.g. hitting
// send twice by habit), without making every other message pay the full
// fragment-safety cost. Accuracy-sensitive: this window only ever gets
// SHORTER for text that independently already reads as complete per the
// caller's own `isComplete` check — it never skips buffering entirely the
// way a true boundary message does, so a same-turn follow-up still merges
// in normally if one arrives within the shorter window.
const QUICK_DEBOUNCE_MS = 1200;

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
 * @param {(concatenatedText: string) => boolean} [options.isComplete] - Identifies text that
 *   already reads as a finished thought on its own (a full transaction sentence, or anything
 *   ending in terminal punctuation) — unlike isBoundary, this does NOT skip buffering, it just
 *   shortens the wait to QUICK_DEBOUNCE_MS instead of the full DEBOUNCE_MS. Evaluated against the
 *   whole buffered text so far (not just the newest fragment), so two short fragments that only
 *   become a complete transaction once combined still get the short window once they do.
 */
export function debounceMessage(senderId, text, onDebounceComplete, options = {}) {
  if (!senderId || !onDebounceComplete) {
    return;
  }

  const { isBoundary, isComplete } = options;
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

  let delay = DEBOUNCE_MS;
  if (isBoundaryMessage) {
    delay = 0;
  } else if (typeof isComplete === 'function') {
    const concatenatedSoFar = buffer.messages.join(' ').trim();
    if (isComplete(concatenatedSoFar)) {
      delay = QUICK_DEBOUNCE_MS;
    }
  }

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