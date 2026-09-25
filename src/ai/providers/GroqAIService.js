import { createAppError } from '../../utils/createAppError.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { cleanJsonResponse } from './GeminiAIService.js';

/**
 * Groq provider — implements the same AIService contract as Gemini:
 *
 *   async completeJson({ system, user, schemaHint }) → object
 *
 * Used as a SECOND provider behind Gemini (see FallbackAIService.js). It has a
 * completely separate quota pool from Google, so a Gemini overload / project
 * quota problem does not touch it.
 *
 * Config (all optional except the key). Read at call time, not import time:
 *   GROQ_API_KEY     enables this provider. Unset = Gemini-only, exactly as before.
 *   GROQ_MODELS      comma-separated, in preference order. Groq limits are PER MODEL,
 *                    so each extra model is extra free capacity.
 *                    default: llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant
 *                    (check console.groq.com for current model names — they change)
 *   GROQ_TIMEOUT_MS  per-attempt timeout (default 8000)
 *   GROQ_BUDGET_MS   total budget for one call across models (default 12000)
 */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_GROQ_MODELS = Object.freeze([
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
]);

// Groq's JSON mode requires the word "JSON" to appear in the messages.
const JSON_REMINDER = '\n\nRespond with a single valid JSON object and nothing else.';

const MIN_ATTEMPT_MS = 1200;
const cooling = new Map(); // model -> epoch ms until which it is skipped as "healthy"

export function isGroqConfigured() {
  return String(process.env.GROQ_API_KEY || '').trim() !== '';
}

export function getGroqModels() {
  const raw = String(process.env.GROQ_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
  return raw.length ? raw : [...DEFAULT_GROQ_MODELS];
}

export function resetGroqHealth() {
  cooling.clear();
}

function orderModels(models, now = Date.now()) {
  const healthy = models.filter((m) => (cooling.get(m) || 0) <= now);
  const resting = models
    .filter((m) => (cooling.get(m) || 0) > now)
    .sort((a, b) => cooling.get(a) - cooling.get(b));
  return [...healthy, ...resting]; // never give up without trying everything
}

function cooldownMs(err) {
  switch (err?.code) {
    case 'AI_MODEL_NOT_FOUND':
      return 6 * 60 * 60_000;
    case 'AI_RATE_LIMIT':
      return Math.min(Math.max(err.retryAfterMs ? err.retryAfterMs + 1000 : 60_000, 10_000), 30 * 60_000);
    case 'AI_TIMEOUT':
    case 'AI_PROVIDER_OVERLOADED':
    case 'AI_PROVIDER_ERROR':
    case 'AI_REQUEST_FAILED':
      return 20_000;
    case 'AI_UNAVAILABLE':
      return 5 * 60_000;
    default:
      return 0; // e.g. one bad-JSON answer says nothing about availability
  }
}

function retryAfterFromHeaders(response) {
  const v = response?.headers?.get?.('retry-after');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 30 * 60_000) : null;
}

export function createGroqAIService(options = {}) {
  async function callModel(model, system, user, schemaHint, timeoutMs) {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) throw createAppError('AI_CONFIG_ERROR', 'GROQ_API_KEY is not configured');
    if (!system || !user) throw createAppError('AI_INVALID_INPUT', 'system and user are required for completeJson');

    const userContent = schemaHint
      ? `${user}\n\nRespond with JSON matching this shape:\n${schemaHint}`
      : user;

    let response;
    try {
      response = await fetchWithTimeout(
        GROQ_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: `${system}${JSON_REMINDER}` },
              { role: 'user', content: userContent },
            ],
          }),
        },
        timeoutMs,
      );
    } catch (err) {
      if (err?.code === 'TIMEOUT') {
        throw createAppError('AI_TIMEOUT', `Groq request timed out after ${timeoutMs}ms`, { cause: err });
      }
      throw createAppError('AI_REQUEST_FAILED', `Groq request failed: ${err.message}`, { cause: err });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw createAppError('AI_INVALID_RESPONSE', `Groq returned non-JSON envelope (HTTP ${response.status})`, { cause: err });
    }

    if (!response.ok) {
      const status = response.status;
      const apiMessage = payload?.error?.message || `HTTP ${status} ${response.statusText}`;
      const apiCode = String(payload?.error?.code || '');

      if (status === 429) {
        const e = createAppError('AI_RATE_LIMIT', `Groq rate limit: ${apiMessage}`, { statusCode: 429 });
        e.retryAfterMs = retryAfterFromHeaders(response);
        throw e;
      }
      if (status === 404 || /decommission|model_not_found/i.test(apiCode + apiMessage)) {
        throw createAppError('AI_MODEL_NOT_FOUND', `Groq model unavailable: ${apiMessage}`, { statusCode: status });
      }
      if (/json_validate_failed/i.test(apiCode)) {
        throw createAppError('AI_INVALID_RESPONSE', `Groq could not produce valid JSON: ${apiMessage}`, { statusCode: status });
      }
      if (status === 503 || status === 498) {
        throw createAppError('AI_PROVIDER_OVERLOADED', `Groq over capacity: ${apiMessage}`, { statusCode: status });
      }
      if (status >= 400 && status < 500) {
        throw createAppError('AI_UNAVAILABLE', `Groq client error: ${apiMessage}`, { statusCode: status });
      }
      throw createAppError('AI_PROVIDER_ERROR', `Groq provider error: ${apiMessage}`, { statusCode: status });
    }

    const raw = payload?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw createAppError('AI_INVALID_RESPONSE', 'Groq response did not include text content');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanJsonResponse(raw));
    } catch (parseErr) {
      throw createAppError('AI_INVALID_RESPONSE', `Failed to parse Groq JSON response: ${parseErr.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw createAppError('AI_INVALID_RESPONSE', 'Groq parsed JSON is not an object');
    }
    return parsed;
  }

  return {
    async completeJson({ system, user, schemaHint }) {
      const startedAt = Date.now();
      const budgetMs = options.budgetMs ?? (Number(process.env.GROQ_BUDGET_MS) || 12000);
      const timeoutMs = options.timeoutMs ?? (Number(process.env.GROQ_TIMEOUT_MS) || 8000);
      let lastError;

      for (const model of orderModels(options.models || getGroqModels())) {
        const remaining = budgetMs - (Date.now() - startedAt);
        if (remaining < MIN_ATTEMPT_MS) break;

        const t0 = Date.now();
        try {
          const result = await callModel(model, system, user, schemaHint, Math.min(timeoutMs, remaining));
          console.log(`[GroqAIService] Answered by ${model} in ${Date.now() - t0}ms`);
          return result;
        } catch (err) {
          lastError = err;
          if (err?.code === 'AI_CONFIG_ERROR' || err?.code === 'AI_INVALID_INPUT') throw err;
          const ms = cooldownMs(err);
          if (ms > 0) cooling.set(model, Date.now() + ms);
          console.warn(
            `[GroqAIService] Model ${model} failed after ${Date.now() - t0}ms: ${err.message}` +
              (ms ? ` — cooling down ${Math.round(ms / 1000)}s` : ''),
          );
        }
      }

      console.error('[GroqAIService] All Groq models failed within budget.');
      throw lastError || createAppError('AI_UNAVAILABLE', 'No Groq model produced a response within budget.');
    },
  };
}

export default { createGroqAIService, isGroqConfigured, getGroqModels };
