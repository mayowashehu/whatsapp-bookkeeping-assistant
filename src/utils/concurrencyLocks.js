import env from '../config/env.js';

const locks = new Map();
// A turn can legitimately run for as long as the AI fallback cascade is
// budgeted for (see env.aiTotalBudgetMs / GeminiAIService.js), plus margin
// for the DB reads/writes and WhatsApp sends that happen around it. This
// must stay derived from the AI budget, not an independent constant —
// that mismatch (previously a hardcoded 30000ms against an *unbounded*
// fallback loop that could run for minutes) is what let a still-running
// turn's lock get force-stolen out from under it, allowing the next queued
// message to start processing concurrently with it.
const LOCK_TTL_MS = env.aiTotalBudgetMs + 30000;

/**
 * Acquires a strict per-sender mutex lock using an atomic promise-chaining queue.
 * Eliminates TOCTOU race conditions and ensures zero overlap for concurrent webhooks.
 */
export async function acquireLock(senderId) {
  if (!senderId || typeof senderId !== 'string') {
    throw new Error('[ConcurrencyLock] A valid string senderId is required to acquire a lock.');
  }

  // Atomically retrieve the current tail promise or resolve immediately if none exists
  const currentLock = locks.get(senderId) || Promise.resolve();

  let releaseNext;
  const nextLock = new Promise((resolve) => {
    releaseNext = resolve;
  });

  // Set the new tail promise in the map
  locks.set(senderId, nextLock);

  // Await the completion of all preceding operations for this sender
  await currentLock;

  let released = false;

  // Safety TTL timer to prevent permanent deadlocks if execution hangs
  const timer = setTimeout(() => {
    if (!released) {
      released = true;
      console.warn(`[ConcurrencyLock] Lock for sender ${senderId} expired after ${LOCK_TTL_MS}ms — forcing release`);
      if (locks.get(senderId) === nextLock) {
        locks.delete(senderId);
      }
      releaseNext();
    }
  }, LOCK_TTL_MS);

  // Return the release function
  return async () => {
    if (!released) {
      released = true;
      clearTimeout(timer);
      if (locks.get(senderId) === nextLock) {
        locks.delete(senderId);
      }
      releaseNext();
    }
  };
}

/**
 * Higher-order helper to execute any asynchronous function safely within a per-sender lock.
 * Guarantees the lock release even if an exception is thrown inside the callback.
 */
export async function withSenderLock(senderId, fn) {
  const release = await acquireLock(senderId);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Returns true if a turn for this sender is currently in-flight (holding or
 * queued for the lock). Used to detect the "still processing your previous
 * message" case rather than leaving a queued caller's message unexplained.
 */
export function isLocked(senderId) {
  return locks.has(senderId);
}

export default {
  acquireLock,
  withSenderLock,
  isLocked,
};