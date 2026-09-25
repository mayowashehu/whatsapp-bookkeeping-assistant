import env from '../../config/env.js';
import {
  getGeminiClassifierModel,
  getStickyModel,
  recordSuccessfulModel,
  markModelCooldown,
  isModelCooling,
  CURATED_FALLBACK_MODELS,
  getGeminiApiKey,
  getGeminiApiKeys,
  rotateGeminiApiKey,
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

const TRANSIENT_CODES = new Set([
  'AI_TIMEOUT',
  'AI_RATE_LIMIT',
  'AI_PROVIDER_OVERLOADED',
  'AI_PROVIDER_ERROR',
  'AI_REQUEST_FAILED',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(payload) {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return null;

  for (const detail of details) {
    const retryDelay = detail?.retryDelay;
    if (typeof retryDelay === 'string') {
      const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
      if (match) return Math.round(Number(match[1]) * 1000);
    }
    if (retryDelay && typeof retryDelay.seconds === 'number') {
      return retryDelay.seconds * 1000 + Math.round((retryDelay.nanos || 0) / 1e6);
    }
  }
  return null;
}

function withRetryAfter(error, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) {
    error.retryAfterMs = retryAfterMs;
  }
  return error;
}

// Sticky-first, then configured, then curated fallbacks. Models that just
// 503'd / timed out are pushed to the end for ~45s so the next user
// message does not immediately re-burn the same hung alias.
function buildAttemptOrder(configuredModel) {
  const preferred = [];
  const cooling = [];
  const seen = new Set();

  function push(model) {
    if (!model || seen.has(model)) return;
    seen.add(model);
    if (isModelCooling(model)) cooling.push(model);
    else preferred.push(model);
  }

  push(getStickyModel());
  push(configuredModel);
  for (const model of CURATED_FALLBACK_MODELS) {
    push(model);
  }
  return [...preferred, ...cooling];
}

function getFastHopTimeoutMs() {
  // First pass hops across candidates quickly. A 503 returns in milliseconds;
  // a hung socket should not consume the whole budget before we try flash
  // (non-lite) or a second API key. Later rounds use the full aiTimeoutMs
  // because a free-tier model that is merely queued often needs 6–10s.
  return Math.min(env.aiTimeoutMs, 5000);
}

/**
 * Gemini AI provider — curated models, optional API-key pool, and a hard
 * total wall-clock budget with one or more backoff retries for free-tier
 * overload (429 / 503 / timeout).
 */
export function createGeminiAIService(options = {}) {
  const configuredModel =
    options.model || getGeminiClassifierModel() || env.geminiClassifierModel;

  async function executeApiCall(targetModel, system, user, schemaHint, timeoutMs, apiKey) {
    if (!apiKey) {
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
            'x-goog-api-key': apiKey,
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
      const retryAfterMs = parseRetryDelayMs(payload);

      if (status === 429) {
        throw withRetryAfter(
          createAppError('AI_RATE_LIMIT', `Rate limit exceeded: ${apiMessage}`, {
            statusCode: 429,
          }),
          retryAfterMs,
        );
      }
      if (status === 404) {
        throw createAppError('AI_MODEL_NOT_FOUND', `Model not found: ${apiMessage}`, {
          statusCode: 404,
        });
      }
      if (status === 503) {
        throw withRetryAfter(
          createAppError('AI_PROVIDER_OVERLOADED', `AI provider overloaded: ${apiMessage}`, {
            statusCode: 503,
          }),
          retryAfterMs,
        );
      }
      if (status >= 400 && status < 500) {
        throw createAppError('AI_UNAVAILABLE', `AI client error: ${apiMessage}`, {
          statusCode: status,
        });
      }

      throw withRetryAfter(
        createAppError('AI_PROVIDER_ERROR', `AI provider error: ${apiMessage}`, {
          statusCode: status,
        }),
        retryAfterMs,
      );
    }

    const rawText = extractText(payload);
    if (!rawText) {
      throw createAppError('AI_INVALID_RESPONSE', 'AI API response did not include text content');
    }

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
      // When a second provider is configured, Gemini gets a shorter leash
      // (options.budgetMs) so a struggling Gemini hands off instead of holding
      // the user's chat for the full 32s. Without a fallback, the full budget applies.
      const budgetMs = options.budgetMs ?? env.aiTotalBudgetMs;
      const keys = getGeminiApiKeys();
      if (keys.length === 0) {
        throw createAppError('AI_CONFIG_ERROR', 'GEMINI_API_KEY is not configured');
      }

      let lastError;
      const skippedModels = new Set();
      let round = 0;

      while (Date.now() - overallStartedAt < budgetMs) {
        const attemptOrder = buildAttemptOrder(configuredModel).filter(
          (model) => !skippedModels.has(model),
        );
        const hopTimeoutMs = round === 0 ? getFastHopTimeoutMs() : env.aiTimeoutMs;

        for (const targetModel of attemptOrder) {
          const elapsedMs = Date.now() - overallStartedAt;
          const remainingBudgetMs = budgetMs - elapsedMs;
          if (remainingBudgetMs <= 400) {
            console.error(
              `[GeminiAIService] AI total budget of ${budgetMs}ms exhausted after ${elapsedMs}ms ` +
                `(${attemptOrder.length - attemptOrder.indexOf(targetModel)} candidate model(s) untried) — giving up.`,
            );
            break;
          }

          const attemptTimeoutMs = Math.min(hopTimeoutMs, remainingBudgetMs);
          const apiKey = getGeminiApiKey();

          try {
            const result = await executeApiCall(
              targetModel,
              system,
              user,
              schemaHint,
              attemptTimeoutMs,
              apiKey,
            );
            recordSuccessfulModel(targetModel);
            return result;
          } catch (err) {
            lastError = err;
            console.warn(
              `[GeminiAIService] Model ${targetModel} failed after ${Date.now() - overallStartedAt - elapsedMs}ms: ${err.message}`,
            );

            if (err.code === 'AI_MODEL_NOT_FOUND' || err.statusCode === 404) {
              skippedModels.add(targetModel);
              continue;
            }

            if (
              err.code === 'AI_RATE_LIMIT' ||
              err.code === 'AI_PROVIDER_OVERLOADED' ||
              err.code === 'AI_TIMEOUT' ||
              err.statusCode === 429 ||
              err.statusCode === 503
            ) {
              markModelCooldown(targetModel);
              if (err.code !== 'AI_TIMEOUT') {
                rotateGeminiApiKey(err.code || `HTTP ${err.statusCode}`);
              }
            }
          }
        }

        if (!TRANSIENT_CODES.has(lastError?.code)) {
          break;
        }

        round += 1;
        const elapsedMs = Date.now() - overallStartedAt;
        const remainingBudgetMs = budgetMs - elapsedMs;
        const requestedBackoffMs = lastError?.retryAfterMs || 800 * 2 ** (round - 1);
        const backoffMs = Math.min(requestedBackoffMs, 4000, Math.max(0, remainingBudgetMs - 2000));

        if (backoffMs < 200 || remainingBudgetMs < 2000) {
          break;
        }

        console.warn(
          `[GeminiAIService] Free-tier overload on round ${round}; waiting ${backoffMs}ms then retrying ` +
            `(${remainingBudgetMs}ms budget left).`,
        );
        await sleep(backoffMs);
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
