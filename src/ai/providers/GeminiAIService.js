import env from '../../config/env.js';
import {
  getGeminiClassifierModel,
  getStickyModel,
  recordSuccessfulModel,
  CURATED_FALLBACK_MODELS,
} from '../../services/ai/geminiClient.js';
import { createAppError } from '../../utils/createAppError.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';

/**
 * Sanitizes AI string responses to guarantee parseable JSON.
 * Removes markdown backticks (```json ... ```) and leading/trailing fluff.
 */
export function cleanJsonResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return '{}';

  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

// FIX (Phase 1.0, 🔴 — confirmed live, Aug 7 transcript + logs): the old
// flow here was: try the configured model, retry it once after a fixed
// 2000ms sleep on 429/503, then — on ANY remaining failure — trigger a
// live "list all models" discovery call and cycle through whatever came
// back (including dead/deprecated/heavy models) at up to the full 30s
// per-attempt timeout each. Measured root cause chain on a real failing
// message: primary model times out at the full 30,000ms → five more
// dead/quota-limited models fail in sequence (~13-15s of pure dead time)
// → a working model is finally reached. Total: 43-45s for one message.
//
// Fixed via three changes, all working together:
//   1. No more dynamic discovery — CURATED_FALLBACK_MODELS (see
//      geminiClient.js) replaces the live catalog call entirely.
//   2. No more in-place retry-with-sleep on the same model — a model that
//      is genuinely overloaded or rate-limited right now is not more
//      likely to succeed 2000ms later than the NEXT model in the curated
//      list is to succeed immediately, so we move on instead of waiting.
//   3. A hard total wall-clock budget (env.aiTotalBudgetMs) that every
//      attempt's own timeout is clamped against, so the cascade can never
//      run longer than that regardless of how many candidates remain.
function buildAttemptOrder(configuredModel) {
  const ordered = [];
  const sticky = getStickyModel();

  if (sticky) {
    ordered.push(sticky);
  }
  if (!ordered.includes(configuredModel)) {
    ordered.push(configuredModel);
  }
  for (const model of CURATED_FALLBACK_MODELS) {
    if (!ordered.includes(model)) {
      ordered.push(model);
    }
  }
  return ordered;
}

/**
 * Gemini AI provider — curated, sticky-first model selection with a hard
 * total wall-clock budget. See buildAttemptOrder / geminiClient.js above
 * for why this replaced the old dynamic-discovery fallback.
 */
export function createGeminiAIService(options = {}) {
  const configuredModel =
    options.model || getGeminiClassifierModel() || env.geminiClassifierModel;

  async function executeApiCall(targetModel, system, user, schemaHint, timeoutMs) {
    if (!env.geminiApiKey) {
      throw createAppError('AI_CONFIG_ERROR', 'GEMINI_API_KEY is not configured');
    }

    if (!system || !user) {
      throw createAppError('AI_INVALID_INPUT', 'system and user are required for completeJson');
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(targetModel)}:generateContent`;

    const userContent = schemaHint
      ? `${user}\n\nRespond with JSON matching this shape:\n${schemaHint}`
      : user;

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    };

    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.geminiApiKey,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (err) {
      if (err?.code === 'TIMEOUT') {
        throw createAppError('AI_TIMEOUT', `AI request timed out after ${timeoutMs}ms`, {
          cause: err,
        });
      }
      throw createAppError('AI_REQUEST_FAILED', `AI request failed: ${err.message}`, {
        cause: err,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw createAppError(
        'AI_INVALID_RESPONSE',
        `AI API returned non-JSON envelope (HTTP ${response.status})`,
        { cause: err }
      );
    }

    if (!response.ok) {
      const status = response.status;
      const apiMessage = payload?.error?.message || `HTTP ${status} ${response.statusText}`;

      if (status === 429) {
        throw createAppError('AI_RATE_LIMIT', `Rate limit exceeded: ${apiMessage}`, {
          statusCode: 429,
        });
      }
      if (status === 404) {
        throw createAppError('AI_MODEL_NOT_FOUND', `Model not found: ${apiMessage}`, {
          statusCode: 404,
        });
      }
      if (status === 503) {
        throw createAppError('AI_PROVIDER_OVERLOADED', `AI provider overloaded: ${apiMessage}`, {
          statusCode: 503,
        });
      }
      if (status >= 400 && status < 500) {
        throw createAppError('AI_UNAVAILABLE', `AI client error: ${apiMessage}`, {
          statusCode: status,
        });
      }

      throw createAppError('AI_PROVIDER_ERROR', `AI provider error: ${apiMessage}`, {
        statusCode: status,
      });
    }

    const rawText = extractText(payload);
    if (!rawText) {
      throw createAppError('AI_INVALID_RESPONSE', 'AI API response did not include text content');
    }

    // Apply JSON sanitization step
    const cleanedString = cleanJsonResponse(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleanedString);
    } catch (parseErr) {
      throw createAppError('AI_INVALID_RESPONSE', `Failed to parse AI JSON response: ${parseErr.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw createAppError('AI_INVALID_RESPONSE', 'Parsed JSON is not an object');
    }
    return parsed;
  }

  return {
    async completeJson({ system, user, schemaHint }) {
      const overallStartedAt = Date.now();
      const attemptOrder = buildAttemptOrder(configuredModel);
      let lastError;

      for (let i = 0; i < attemptOrder.length; i++) {
        const targetModel = attemptOrder[i];
        const elapsedMs = Date.now() - overallStartedAt;
        const remainingBudgetMs = env.aiTotalBudgetMs - elapsedMs;

        // FIX (Phase 1.0c): total budget is checked BEFORE every attempt,
        // not just between fallback rounds — a real flash-lite model that's
        // actually available answers in 1-3s, so if we're already close to
        // the budget there's no point starting another network round trip
        // that can't possibly finish in time anyway.
        if (remainingBudgetMs <= 250) {
          console.error(
            `[GeminiAIService] AI total budget of ${env.aiTotalBudgetMs}ms exhausted after ${elapsedMs}ms ` +
              `(${attemptOrder.length - i} candidate model(s) untried: ${attemptOrder.slice(i).join(', ')}) — giving up.`
          );
          break;
        }

        // Clamp this attempt's own timeout to whatever budget remains — no
        // artificial floor here: forcing a minimum timeout higher than the
        // remaining budget would let a single attempt blow past the total
        // budget cap this is meant to enforce (caught by testing: with a
        // tight budget, a floor here let one hung attempt consume the
        // entire budget and starve every other candidate). The
        // remainingBudgetMs <= 250 check above already guarantees we never
        // start an attempt with too little time left to be worthwhile.
        const attemptTimeoutMs = Math.min(env.aiTimeoutMs, remainingBudgetMs);

        try {
          const result = await executeApiCall(targetModel, system, user, schemaHint, attemptTimeoutMs);
          recordSuccessfulModel(targetModel);
          return result;
        } catch (err) {
          lastError = err;
          console.warn(
            `[GeminiAIService] Model ${targetModel} failed after ${Date.now() - overallStartedAt - elapsedMs}ms: ${err.message}`
          );
        }
      }

      console.error('[GeminiAIService] All candidate models failed within the AI budget.');
      throw lastError || createAppError('AI_UNAVAILABLE', 'No AI model produced a response within the configured budget.');
    },
  };
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }

  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  return text || null;
}

export default {
  createGeminiAIService,
  cleanJsonResponse,
};
