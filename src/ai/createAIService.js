import env from '../config/env.js';
import { getGeminiClassifierModel } from '../services/ai/geminiClient.js';
import { createGeminiAIService } from './providers/GeminiAIService.js';

/**
 * Factory — the only place that selects a concrete AI provider.
 * Callers receive an AIService contract implementation and must
 * never import provider modules directly.
 *
 * @param {{ model?: string }} [options]
 * @returns {import('./AIService.js').AIService}
 */
export function createAIService(options = {}) {
  return createGeminiAIService({
    model: options.model || getGeminiClassifierModel() || env.geminiClassifierModel,
  });
}

export default {
  createAIService,
};
