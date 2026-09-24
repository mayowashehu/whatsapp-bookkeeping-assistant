/**
 * Central Gemini model resolution — never hardcode model strings elsewhere.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

// Curated fast-tier models only. No live catalog discovery — that used to
// cycle dead/heavy models and burn 40s+ per message.
//
// gemini-flash-latest is included alongside flash-lite: on the free tier
// the two families often sit on different capacity pools, so a "high
// demand" 503 on lite can still succeed on flash (and vice versa).
//
// Permanently excluded (confirmed dead for new keys / this era):
//   - gemini-2.5-flash / gemini-2.5-flash-lite — 404 "no longer available to new users"
//   - gemini-2.0-flash / gemini-2.0-flash-lite — shut down June 1, 2026
export const CURATED_FALLBACK_MODELS = Object.freeze([
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

const MODEL_COOLDOWN_MS = 45_000;

let stickyModel = null;
const modelCoolingUntil = new Map();
let apiKeyIndex = 0;

function parseGeminiApiKeys() {
  const fromList = String(process.env.GEMINI_API_KEYS || '')
    .split(/[,;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const primary = String(process.env.GEMINI_API_KEY || '').trim();
  const keys = [];
  const seen = new Set();
  for (const key of [primary, ...fromList]) {
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function getGeminiApiKeys() {
  return parseGeminiApiKeys();
}

export function getGeminiApiKey() {
  const keys = parseGeminiApiKeys();
  if (keys.length === 0) return '';
  return keys[apiKeyIndex % keys.length];
}

/**
 * Move to the next configured key. Free-tier 429s are often per-key RPM;
 * rotating the extra keys already created in AI Studio is the cheapest
 * way to keep a single-user bot alive without billing.
 */
export function rotateGeminiApiKey(reason = 'transient error') {
  const keys = parseGeminiApiKeys();
  if (keys.length === 0) return '';
  if (keys.length === 1) return keys[0];
  apiKeyIndex = (apiKeyIndex + 1) % keys.length;
  console.warn(
    `[Gemini] Rotated API key after ${reason} (now key ${apiKeyIndex + 1}/${keys.length})`,
  );
  return keys[apiKeyIndex];
}

export function getStickyModel() {
  if (stickyModel && isModelCooling(stickyModel)) {
    return null;
  }
  return stickyModel;
}

export function recordSuccessfulModel(model) {
  if (typeof model === 'string' && model.trim()) {
    const name = model.trim();
    stickyModel = name;
    modelCoolingUntil.delete(name);
  }
}

export function markModelCooldown(model, cooldownMs = MODEL_COOLDOWN_MS) {
  if (typeof model !== 'string' || !model.trim()) return;
  const name = model.trim();
  modelCoolingUntil.set(name, Date.now() + cooldownMs);
  if (stickyModel === name) {
    stickyModel = null;
  }
}

export function isModelCooling(model) {
  const until = modelCoolingUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCoolingUntil.delete(model);
    return false;
  }
  return true;
}

export function getGeminiModel(override) {
  return override || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

export function getGeminiClassifierModel(override) {
  return override || process.env.GEMINI_CLASSIFIER_MODEL || getGeminiModel();
}

export function getGeminiParserModel(override) {
  return override || process.env.GEMINI_PARSER_MODEL || getGeminiModel();
}

export function getGeminiQueryModel(override) {
  return override || process.env.GEMINI_QUERY_MODEL || getGeminiModel();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MEDIA_TRANSIENT_CODES = new Set([
  'AI_TIMEOUT',
  'AI_RATE_LIMIT',
  'AI_PROVIDER_OVERLOADED',
  'AI_PROVIDER_ERROR',
  'AI_REQUEST_FAILED',
  'TRANSCRIPTION_TIMEOUT',
  'TRANSCRIPTION_PROVIDER_ERROR',
  'TRANSCRIPTION_REQUEST_FAILED',
  'RECEIPT_TIMEOUT',
  'RECEIPT_PROVIDER_ERROR',
  'RECEIPT_REQUEST_FAILED',
]);

/**
 * Retry wrapper for voice/receipt Gemini calls. Text JSON extraction has
 * its own cascade inside GeminiAIService; media calls are a single model
 * so they retry with backoff + key rotation instead.
 */
export async function withGeminiTransientRetry(runOnce, { maxRounds = 3, label = 'Gemini' } = {}) {
  let lastError;
  for (let round = 0; round < maxRounds; round++) {
    try {
      return await runOnce(getGeminiApiKey());
    } catch (err) {
      lastError = err;
      const transient =
        MEDIA_TRANSIENT_CODES.has(err?.code) ||
        err?.statusCode === 429 ||
        err?.statusCode === 503;
      if (!transient || round === maxRounds - 1) {
        throw err;
      }
      rotateGeminiApiKey(err.code || 'overload');
      const wait = Math.min(err.retryAfterMs || 800 * 2 ** round, 4000);
      console.warn(
        `[${label}] Transient failure; retrying in ${wait}ms (round ${round + 1}/${maxRounds}): ${err.message}`,
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

export default {
  DEFAULT_GEMINI_MODEL,
  CURATED_FALLBACK_MODELS,
  getStickyModel,
  recordSuccessfulModel,
  markModelCooldown,
  isModelCooling,
  getGeminiApiKey,
  getGeminiApiKeys,
  rotateGeminiApiKey,
  getGeminiModel,
  getGeminiClassifierModel,
  getGeminiParserModel,
  getGeminiQueryModel,
  withGeminiTransientRetry,
  sleep,
};
