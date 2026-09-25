import env from '../config/env.js';
import {
  getGeminiClassifierModel,
  isModelCooling,
  CURATED_FALLBACK_MODELS,
} from '../services/ai/geminiClient.js';
import { createGeminiAIService } from './providers/GeminiAIService.js';
import { createGroqAIService, isGroqConfigured } from './providers/GroqAIService.js';
import { createFallbackAIService } from './FallbackAIService.js';
import { createAppError } from '../utils/createAppError.js';

// With a second provider available, Gemini should hand off after a modest wait
// instead of holding the chat for its full (Gemini-only) budget.
const GEMINI_BUDGET_WITH_FALLBACK_MS = () =>
  Number(process.env.GEMINI_BUDGET_WITH_FALLBACK_MS) || 12000;

/**
 * TEST SWITCH: set AI_FORCE_GEMINI_DOWN=true (Render env var) to make Gemini
 * "fail" instantly so every request exercises the REAL failover path and is
 * answered by Groq. Ignored (with a warning) if GROQ_API_KEY is not set, so it
 * can never leave the bot with no AI at all. REMOVE IT when you're done testing.
 */
function isGeminiMuted() {
  return String(process.env.AI_FORCE_GEMINI_DOWN || '').trim().toLowerCase() === 'true';
}

const mutedGemini = {
  async completeJson() {
    throw createAppError(
      'AI_PROVIDER_OVERLOADED',
      '[TEST MODE] Gemini is muted by AI_FORCE_GEMINI_DOWN=true — remove this env var to re-enable it.',
    );
  },
};

/**
 * Factory — the only place that selects a concrete AI provider.
 * Callers receive an AIService contract implementation and must
 * never import provider modules directly.
 *
 * Gemini is the primary provider. If GROQ_API_KEY is set, Groq is added as an
 * automatic second provider; if it is not set, behavior is Gemini-only, as before.
 *
 * @param {{ model?: string }} [options]
 * @returns {import('./AIService.js').AIService}
 */
export function createAIService(options = {}) {
  const geminiModel = options.model || getGeminiClassifierModel() || env.geminiClassifierModel;

  if (!isGroqConfigured()) {
    if (isGeminiMuted()) {
      console.warn('[AIService] AI_FORCE_GEMINI_DOWN=true ignored: GROQ_API_KEY is not set, so Gemini stays on.');
    }
    return createGeminiAIService({ model: geminiModel });
  }

  const muted = isGeminiMuted();
  const gemini = muted
    ? mutedGemini
    : createGeminiAIService({
        model: geminiModel,
        budgetMs: GEMINI_BUDGET_WITH_FALLBACK_MS(),
      });
  const groq = createGroqAIService();

  // Gemini is "known degraded" when every model we would try is cooling down.
  const geminiCandidates = [...new Set([geminiModel, ...CURATED_FALLBACK_MODELS])];

  return createFallbackAIService({
    primary: { name: 'gemini', service: gemini },
    secondary: { name: 'groq', service: groq },
    isPrimaryDegraded: () => !muted && geminiCandidates.every((m) => isModelCooling(m)),
  });
}

export default {
  createAIService,
};
