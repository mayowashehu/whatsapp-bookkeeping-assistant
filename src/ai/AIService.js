/**
 * AIService contract.
 *
 * Every provider implementation MUST expose:
 *
 *   async completeJson({ system, user, schemaHint }) → object
 *
 * Rules:
 * - Returns a parsed JavaScript object (never raw model prose).
 * - Providers may throw structured errors for transport/config failures.
 * - Callers MUST still validate the object against their own schema —
 *   never trust AI output blindly.
 *
 * Application code must depend only on this contract via
 * `createAIService()` — never on a concrete provider.
 */

/**
 * @typedef {object} CompleteJsonInput
 * @property {string} system System instructions.
 * @property {string} user User payload / message to analyze.
 * @property {string} [schemaHint] Short description of the expected JSON shape.
 */

/**
 * @typedef {object} AIService
 * @property {(input: CompleteJsonInput) => Promise<object>} completeJson
 */

export const AIServiceContract = Object.freeze({
  method: 'completeJson',
  resultShape: 'object',
});
