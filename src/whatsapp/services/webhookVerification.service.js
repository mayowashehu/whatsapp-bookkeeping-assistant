import env from '../../config/env.js';
import { createError } from '../../utils/createError.js';

/**
 * Handles Meta webhook verification (GET /webhook).
 */
export function verifyWebhookChallenge({ mode, token, challenge }) {
  const verifyToken = env.whatsapp.verifyToken;

  if (!verifyToken) {
    throw createError('WHATSAPP_VERIFY_TOKEN is not configured', 500);
  }

  if (mode !== 'subscribe') {
    throw createError('Invalid hub.mode', 403);
  }

  if (!token || token !== verifyToken) {
    throw createError('Webhook verify token mismatch', 403);
  }

  if (challenge === undefined || challenge === null || challenge === '') {
    throw createError('Missing hub.challenge', 400);
  }

  return String(challenge);
}
