import { AI_UNAVAILABLE_CODES } from './aiFallback.js';

/**
 * Cross-provider failover that still satisfies the AIService contract, so
 * MessageClassifier / TransactionParser / QueryInterpreter etc. never know a
 * second provider exists.
 *
 * Behavior:
 *  - Normal: primary first, secondary only if the primary is unavailable.
 *  - Known outage (isPrimaryDegraded): secondary FIRST, so users don't pay the
 *    primary's timeouts on every message while it's down. The primary's own
 *    cooldowns expire on their own, at which point it is probed again.
 *  - If both fail, throws an "unavailable"-class error, so the existing
 *    isAiUnavailableError() paths (and the retry queue) behave exactly as before.
 */
export function createFallbackAIService({ primary, secondary, isPrimaryDegraded = () => false, log = console }) {
  return {
    async completeJson(input) {
      const order = isPrimaryDegraded()
        ? [{ name: secondary.name, svc: secondary.service }, { name: primary.name, svc: primary.service }]
        : [{ name: primary.name, svc: primary.service }, { name: secondary.name, svc: secondary.service }];

      let lastError;
      let unavailableError;

      for (let i = 0; i < order.length; i++) {
        const { name, svc } = order[i];
        try {
          const result = await svc.completeJson(input);
          if (i > 0 || name === secondary.name) {
            log.warn(`[AIService] Answered by fallback provider: ${name}`);
          }
          return result;
        } catch (err) {
          if (err?.code === 'AI_INVALID_INPUT') throw err; // caller bug; no provider can fix it
          lastError = err;
          if (AI_UNAVAILABLE_CODES.includes(err?.code)) unavailableError = err;
          log.warn(
            `[AIService] ${name} failed (${err?.code || 'ERROR'}: ${err?.message}); ` +
              (i < order.length - 1 ? `trying ${order[i + 1].name}.` : 'no providers left.'),
          );
        }
      }
      throw unavailableError || lastError;
    },
  };
}

export default { createFallbackAIService };
