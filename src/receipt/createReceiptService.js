/**
 * Factory — the only place that selects a concrete receipt-reading
 * provider. Callers receive a ReceiptService contract implementation
 * (see ReceiptService.js) and must never import provider modules directly.
 *
 * Mirrors createTranscriptionService.js: v0.1 uses Gemini exclusively.
 * Future providers can be switched here without changing
 * ReceiptMessageService.js or MessageRouter.js.
 *
 * @returns {import('./ReceiptService.js').ReceiptServiceContract}
 */
import { createGeminiReceiptService } from './providers/GeminiReceiptService.js';

export function createReceiptService() {
  return createGeminiReceiptService();
}

export default { createReceiptService };