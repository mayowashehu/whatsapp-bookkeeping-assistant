import { isAiBusyReply } from '../../ai/aiFallback.js';
import { card } from '../../utils/waFormat.js';

/**
 * Durable retry queue for messages that failed ONLY because the AI provider
 * was unavailable.
 *
 * Contract:
 *  - A message is never lost: it is persisted, then retried with backoff.
 *  - Per-sender FIFO order is preserved. If a sender has anything queued,
 *    their newer messages queue BEHIND it (so "paid 15k for diesel" followed
 *    by "yes" still resolves in that order).
 *  - After the last retry fails, the user is told plainly and shown what to resend.
 *
 * All I/O is injected so the logic is unit-testable without MongoDB/WhatsApp
 * (see index.js for the real wiring, and __tests__/deferredMessage.test.js).
 */

// Delay before retry #1, #2, ... — front-loaded (most 503 spikes clear within
// a minute or two) and ~36 minutes in total before giving up.
export const RETRY_DELAYS_MS = Object.freeze([
  20_000, 45_000, 90_000, 180_000, 360_000, 600_000, 900_000,
]);

const STALE_PROCESSING_MS = 5 * 60_000;

/** Short, WhatsApp-formatting-safe preview of the user's original text. */
export function previewText(text, max = 60) {
  const clean = String(text || '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function buildDeferredAckReply() {
  return card(
    '🕒',
    'Saved — Retrying Automatically',
    [
      "The assistant is very busy right now, but I've saved your message.",
      "I'll process it automatically and reply here. You don't need to resend it.",
    ],
    'This usually clears within a minute or two.',
  );
}

export function buildQueuedBehindReply() {
  return card(
    '📥',
    'Saved — In Line',
    ["I'm still working through your earlier message, so I've queued this one right behind it."],
    "I'll reply as soon as it's done — in order.",
  );
}

export function buildAlreadySavedReply() {
  return card(
    '✅',
    'Already Saved',
    ["I already have this exact message and I'm still working on it."],
    "No need to resend — I'll reply here as soon as it's done.",
  );
}

/** Loose comparison so "Paid 15k for diesel." and "paid 15k for  diesel" count as the same message. */
export function normalizeForDedupe(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildSuccessReply(item, replyText) {
  return `↩️ _Re: "${previewText(item.text)}"_\n\n${replyText}`;
}

function buildGiveUpReply(item) {
  return card(
    '⚠️',
    "Couldn't Process This One",
    [
      'I kept trying, but the AI service stayed unavailable for this message:',
      `_"${previewText(item.text, 120)}"_`,
    ],
    'Please send it again in a little while.',
  );
}

export function createDeferredMessageService({
  repo,
  processMessage,
  sendText,
  withLock,
  now = () => Date.now(),
  retryDelays = RETRY_DELAYS_MS,
  log = console,
}) {
  async function enqueue({ senderId, text, sourceMessageId }) {
    return repo.insert({
      senderId,
      text,
      sourceMessageId,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(now() + retryDelays[0]),
    });
  }

  /**
   * True if this sender already has the same message waiting/being retried.
   * Stops an impatient resend from creating a second copy of the same
   * transaction (and burning a second AI call). Fail-open on DB errors.
   */
  async function isDuplicateOfActive(senderId, text) {
    try {
      const wanted = normalizeForDedupe(text);
      if (!wanted) return false;
      const active = await repo.listActive(senderId);
      return active.some((row) => normalizeForDedupe(row.text) === wanted);
    } catch (err) {
      log.error('[DeferredMessage] duplicate check failed:', err?.message || err);
      return false;
    }
  }

  /** Fail-open: if the DB check itself fails, behave as if nothing is queued. */
  async function hasPending(senderId) {
    try {
      return await repo.hasActive(senderId);
    } catch (err) {
      log.error('[DeferredMessage] hasPending check failed:', err?.message || err);
      return false;
    }
  }

  async function safeSend(senderId, text) {
    try {
      const res = await sendText(senderId, text);
      if (res && res.success === false) {
        log.error('[DeferredMessage] send failed:', res.error?.message || res.error);
      }
    } catch (err) {
      log.error('[DeferredMessage] send threw:', err?.message || err);
    }
  }

  /** Returns 'done' | 'retry_later' | 'gave_up'. */
  async function runOne(item) {
    let result;
    let error;
    try {
      result = await processMessage({ content: item.text, fromNumber: item.senderId });
    } catch (err) {
      error = err;
    }

    if (!error && !isAiBusyReply(result)) {
      // Mark done BEFORE sending: a failed/duplicated send is far better than
      // re-running the message and creating a second draft.
      await repo.complete(item._id);
      if (result?.replyText) {
        await safeSend(item.senderId, buildSuccessReply(item, result.replyText));
      } else {
        log.warn(`[DeferredMessage] ${item._id} processed with no reply text.`);
      }
      return 'done';
    }

    const attempts = (item.attempts || 0) + 1;
    const lastError = String(error?.message || 'AI still unavailable').slice(0, 300);

    if (attempts >= retryDelays.length) {
      await repo.fail(item._id, { attempts, lastError });
      await safeSend(item.senderId, buildGiveUpReply(item));
      log.warn(`[DeferredMessage] ${item._id} gave up after ${attempts} retries.`);
      return 'gave_up';
    }

    await repo.reschedule(item._id, {
      attempts,
      lastError,
      nextAttemptAt: new Date(now() + retryDelays[attempts]),
    });
    log.log(
      `[DeferredMessage] ${item._id} retry ${attempts}/${retryDelays.length} failed; ` +
        `next in ${Math.round(retryDelays[attempts] / 1000)}s.`,
    );
    return 'retry_later';
  }

  /** Runs inside the sender lock. Oldest first; stops at the first item that must wait. */
  async function drainSender(senderId) {
    const queue = await repo.listPending(senderId);
    if (!queue.length) return;
    // Only the head decides "is it time yet"; items behind it follow as soon as it clears.
    if (new Date(queue[0].nextAttemptAt).getTime() > now()) return;

    for (const item of queue) {
      const claimed = await repo.claim(item._id);
      if (!claimed) continue; // another worker/instance took it
      const outcome = await runOne(claimed);
      if (outcome === 'retry_later') break; // keep order: don't leapfrog a failing head
    }
  }

  async function processDue() {
    await repo.recoverStale(new Date(now() - STALE_PROCESSING_MS));
    const senders = (await repo.listDueSenders(new Date(now()))).slice(0, 25);
    for (const senderId of senders) {
      try {
        await withLock(senderId, () => drainSender(senderId));
      } catch (err) {
        log.error(`[DeferredMessage] drain failed for a sender:`, err?.message || err);
      }
    }
  }

  return { enqueue, hasPending, isDuplicateOfActive, processDue, drainSender };
}

export default { createDeferredMessageService, RETRY_DELAYS_MS };
