import ProcessedMessage from '../models/ProcessedMessage.js';

/**
 * Returns true if this message has already been processed.
 * Uses Mongo unique indexes for atomicity.
 */
export async function markMessageProcessed(messageId, senderId) {
  try {
    await ProcessedMessage.create({
      messageId,
      senderId,
    });

    return true;
  } catch (err) {
    // Duplicate key means we've already processed it.
    if (err?.code === 11000) {
      return false;
    }

    throw err;
  }
}

export default {
  markMessageProcessed,
};