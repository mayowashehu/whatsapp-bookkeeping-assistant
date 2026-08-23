/**
 * Central Gemini model resolution — never hardcode model strings elsewhere.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

// FIX (Phase 1.0b/1.0d, 🔴 — confirmed live, Aug 7 transcript + logs):
// GeminiAIService used to fall back to a *dynamically discovered* catalog
// (a live GET /v1beta/models call) any time the primary model failed. That
// catalog includes dead/deprecated/heavy models with zero relevance to a
// fast JSON-extraction task — the live test showed five dead/quota-limited
// models tried in sequence (each up to the full per-attempt timeout) before
// a working one was finally reached, adding ~13-15s of pure dead time on
// top of the primary's own timeout.
//
// This curated list replaces that dynamic discovery entirely. It is
// deliberately short (3-4 models), deliberately fast-tier only
// (flash-lite class — this app only ever needs cheap categorization /
// structured extraction, never deep reasoning), and deliberately excludes
// anything confirmed dead or quota-restricted for this project:
//   - gemini-2.5-flash: confirmed 404 "no longer available to new users"
//     in the live test — permanently excluded.
//   - gemini-2.0-flash / gemini-2.0-flash-lite (and the "-001" variants):
//     Google shut these down June 1, 2026 — any request 404s.
//   - *-pro / *-preview / heavy or experimental models: intentionally
//     never attempted for this use case — they are both slower and more
//     likely to be quota-restricted than a lite model, so trying them
//     first (or at all) only adds dead time to a task that doesn't need
//     that level of reasoning.
//
// "-latest" aliases are Google's own rolling pointers to whatever is
// currently the GA fast/lite model, so this list keeps working as Google
// ships new model generations without needing a code change — the
// concrete versioned models below it are just extra safety nets in case
// an alias itself is ever unavailable on a given key/tier.
//
// gemini-2.5-flash-lite removed (confirmed 404 "no longer available to
// new users" — live error, Aug 2026): keeping a permanently-dead model in
// the fallback chain doesn't just waste one attempt's latency on this
// project, it wastes it on *every* brand-new Google Cloud project this
// code ever runs under from now on, since new projects never had access
// to it to begin with. If Google deprecates one of the remaining entries
// the same way, remove it here the same way — don't leave dead models in
// this list "just in case."
export const CURATED_FALLBACK_MODELS = Object.freeze([
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

// FIX (Phase 1.0b): "sticky" self-healing model selection. API keys get
// rotated and Google's own model availability shifts over time — a model
// name baked into .env today can be wrong (quota-restricted, deprecated)
// on tomorrow's key. Rather than re-discovering availability from scratch
// on every single request (the old dynamic-catalog approach), remember
// in-memory which model last actually answered successfully and try that
// one first next time. This adapts automatically to whichever key/tier is
// active without any code or config change, and costs nothing extra on
// the happy path (it's just an in-memory string, checked before the first
// network call).
//
// Deliberately process-local, in-memory only (no persistence) — this is a
// speed optimization for the current process's hot path, not a source of
// truth. A restart simply re-learns it on the next request, which is fine.
let stickyModel = null;

export function getStickyModel() {
  return stickyModel;
}

export function recordSuccessfulModel(model) {
  if (typeof model === 'string' && model.trim()) {
    stickyModel = model.trim();
  }
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

export default {
  DEFAULT_GEMINI_MODEL,
  CURATED_FALLBACK_MODELS,
  getStickyModel,
  recordSuccessfulModel,
  getGeminiModel,
  getGeminiClassifierModel,
  getGeminiParserModel,
  getGeminiQueryModel,
};