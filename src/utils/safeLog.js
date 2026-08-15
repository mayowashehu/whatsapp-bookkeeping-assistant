/**
 * Safe operational logging helpers for WhatsApp handlers.
 * Never log secrets, full phone numbers, or message bodies.
 */

export function truncateSenderId(senderId) {
  const digits = String(senderId || '').replace(/\D/g, '');
  if (!digits) {
    return 'unknown';
  }
  if (digits.length <= 4) {
    return `****${digits}`;
  }
  return `****${digits.slice(-4)}`;
}

/**
 * @param {string} scope
 * @param {{
 *   messageId?: string|null,
 *   intent?: string|null,
 *   status: string,
 *   durationMs?: number,
 *   senderId?: string|null,
 *   detail?: string
 * }} fields
 */
export function logProcessingEvent(scope, fields) {
  const parts = [
    `messageId=${fields.messageId || 'none'}`,
    `intent=${fields.intent || 'none'}`,
    `status=${fields.status}`,
    `durationMs=${fields.durationMs ?? 0}`,
    `sender=${truncateSenderId(fields.senderId)}`,
  ];

  if (fields.detail) {
    parts.push(`detail=${fields.detail}`);
  }

  console.log(`[${scope}] ${parts.join(' ')}`);
}

/**
 * Logs full internal error details for operators — never send this text to WhatsApp.
 */
export function logInternalError(scope, err, fields = {}) {
  const code =
    err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'UNKNOWN_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  console.error(
    `[${scope}] Internal error messageId=${fields.messageId || 'none'} ` +
      `sender=${truncateSenderId(fields.senderId)} code=${code}: ${message}`,
  );
  if (stack) {
    console.error(stack);
  }
}

export default {
  truncateSenderId,
  logProcessingEvent,
  logInternalError,
};
