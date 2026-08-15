import env from '../config/env.js';
import { createAIService } from '../ai/createAIService.js';
import { normalizeAmount, normalizeTransactionDate } from '../ai/parsing/TransactionNormalizer.js';
import { formatLagosDisplayDate } from '../utils/dateFormatter.js';

export function sanitizePatch(patch) {
  const clean = {};

  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    clean[key] = value;
  }

  return clean;
}

export function buildDeterministicPatch(text, knownProperties = []) {
  const clean = String(text || '').trim();
  const patch = {};

  const propertyMatch =
    clean.match(/(?:change|switch|update|edit|make)\s+(?:the\s+)?property(?:\s+name)?\s+(?:to|as)\s+(.+?)(?:\s+instead)?[.!]?$/i)
    || clean.match(/(?:use|set)\s+(?:the\s+)?property\s+(?:to|as)\s+(.+?)(?:\s+instead)?[.!]?$/i);

  if (propertyMatch) {
    patch.property = propertyMatch[1].replace(/\s+instead\s*$/i, '').trim();
  }

  const amountMatch = clean.match(/(?:change|switch|update|edit|make)\s+(?:the\s+)?amount\s+(?:to|as)\s+(.+?)[.!]?$/i);
  if (amountMatch) {
    patch.amount = amountMatch[1].trim();
  }

  // PRE-EXISTING BUG FIX (found via baseline test run before Phase 6 work,
  // confirmed by the existing transactionDraftFlow.test.js expectation —
  // not part of Phase 6.1-6.5 itself, flagged and fixed here since it sits
  // directly in the correction/state-machine path Phase 6 hardens and a
  // regression test already existed for the correct behavior):
  // "year" was previously included in this alternation, so "Edit the year
  // to 2026" matched deterministically and set transactionDate = "2026" —
  // a bare year, not a valid date — bypassing the AI path entirely and
  // silently accepting an incomplete/invalid value. A bare year alone can
  // never safely stand in for a full transactionDate without knowing which
  // month/day it applies to, so this case must never be resolved
  // deterministically; only "date"/"day"/"month" (each followed by an
  // explicit full value in the matched group) stay in the fast path.
  const dateMatch = clean.match(/(?:change|switch|update|edit|make)\s+(?:the\s+)?(?:date|day|month)\s+(?:to|as)\s+(.+?)[.!]?$/i);
  if (dateMatch) {
    patch.transactionDate = dateMatch[1].trim();
  }

  const categoryMatch = clean.match(/(?:change|switch|update|edit|make)\s+(?:the\s+)?category\s+(?:to|as)\s+(.+?)[.!]?$/i);
  if (categoryMatch) {
    patch.category = categoryMatch[1].trim();
  }

  if (/(?:change|switch|make).*(?:income|expense)|(?:it\s*'?s|this\s+is)\s+an?\s+(income|expense)/i.test(clean)) {
    const typeMatch = clean.match(/\b(income|expense)\b/i);
    if (typeMatch) {
      patch.type = typeMatch[1].toLowerCase();
    }
  }

  if (Object.keys(patch).length > 0) {
    return sanitizePatch(patch);
  }

  const names = knownProperties.map((property) => property?.name).filter(Boolean);
  for (const name of names.sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    if (pattern.test(clean) && /(?:change|switch|update|property|instead|use|set)/i.test(clean)) {
      patch.property = name;
      break;
    }
  }

  return sanitizePatch(patch);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a structured correction patch from user text.
 * Lives outside the draft layer so CorrectionProcessor never calls AI.
 *
 * @param {string} text
 * @param {object} options
 * @param {Array} [options.knownProperties]
 * @param {object} [options.aiService]
 * @param {'draft'|'confirmed-entry'} [options.context='draft'] - Task 3.3:
 *   editConfirmedTransaction.service.js reuses this same parser for a
 *   different situation (an already-saved, possibly old entry, not a
 *   same-conversation draft). The deterministic patterns and JSON schema
 *   are identical either way; only this one sentence of the AI prompt
 *   changes, so the two flows don't drift into two slightly different
 *   patch parsers over time.
 * @param {Date|string} [options.currentTransactionDate] - Fix (follow-up
 *   to Phase 6.3's buildDeterministicPatch bug fix): a partial date edit
 *   like "edit the year to 2026" only ever specifies ONE component of the
 *   date. Without knowing what the transaction's date currently is, the AI
 *   has nothing to combine that year with and is left guessing the rest.
 *   Passing the current date lets the prompt tell it explicitly what to
 *   keep and what to change, e.g. "27 Jul 2025" + "the year to 2026" =
 *   "2026-07-27", not a bare "2026". Optional and additive — omitting it
 *   just means partial-date edits fall back to the AI's own best guess
 *   from the message alone, the same as before this option existed.
 * @param {string} [options.currentDraftSummary] - Bug fix (manual WhatsApp
 *   testing): a correction message that actually describes a DIFFERENT
 *   transaction than the one currently active — e.g. "Edit the amount of
 *   this my transaction: 'Paid 10k for cleaning at orchid' to 20k" while
 *   the active draft was actually "fuel at Sunset Villa" — was getting its
 *   one extractable number (20000) blindly applied to the active draft,
 *   silently producing a nonsensical "₦20,000 for fuel at Sunset Villa."
 *   Passing a short summary of what the active draft currently represents
 *   (e.g. "[Expense] ₦12,000 for Sunset Villa (fuel)") lets the prompt
 *   compare the two and refuse to patch when they clearly conflict —
 *   returning a mismatch flag instead so the caller can ask rather than
 *   guess. Optional — omitting it just means this check doesn't run, same
 *   as before this option existed.
 * @returns {Promise<{ patch: object, parseResult: object }>} parseResult
 *   may include `possibleMismatch: true` and a human-readable
 *   `mismatchNote` when currentDraftSummary was supplied and the AI judged
 *   the request describes a different transaction. Callers should ask for
 *   clarification instead of applying `patch` (which will be empty) in
 *   that case.
 */
export async function buildCorrectionPatch(text, options = {}) {
  const knownProperties = Array.isArray(options.knownProperties) ? options.knownProperties : [];
  const context = options.context === 'confirmed-entry' ? 'confirmed-entry' : 'draft';
  const deterministicPatch = buildDeterministicPatch(text, knownProperties);

  if (Object.keys(deterministicPatch).length > 0) {
    return {
      patch: deterministicPatch,
      parseResult: { aiUnavailable: false, source: 'deterministic' },
    };
  }

  const aiService = options.aiService || createAIService({ model: env.geminiParserModel });

  const situationLine =
    context === 'confirmed-entry'
      ? 'The user is correcting an existing, already-confirmed transaction record (it may be from days ago, not the most recent one).'
      : 'The user is editing an existing unconfirmed transaction draft.';

  const currentDateDisplay = formatLagosDisplayDate(options.currentTransactionDate);
  const currentDateLine = currentDateDisplay
    ? `\nThe transaction's current date is ${currentDateDisplay}. If the user's request only specifies PART of a date (e.g. only a year, only a day, or only a month — "change the year to 2026", "make it the 15th"), combine that part with the current date above and return the FULL corrected date (format: YYYY-MM-DD) — never return a bare year, day, or month on its own. If the user gives a complete new date instead, use exactly what they said and ignore the current date.`
    : '';

  const currentSubjectLine = options.currentDraftSummary
    ? `\nThe transaction you would be editing currently is: ${options.currentDraftSummary}. Before extracting a patch, check whether the user's request is actually describing a DIFFERENT transaction (a different property, category, or context entirely) rather than correcting a field on THIS one. If it clearly describes a different transaction, do NOT extract a patch at all — instead return "possibleMismatch": true and a short "mismatchNote" explaining what seems different (e.g. "the message mentions cleaning at Orchid, but the current transaction is fuel at Sunset Villa"). Only extract a patch when you're confident the request is meant to correct THIS transaction.`
    : '';

  const prompt = `
You are a precision bookkeeping patch generator for a WhatsApp property-management assistant.
${situationLine}${currentDateLine}${currentSubjectLine}

User request: "${text}"

Available properties: ${JSON.stringify(knownProperties.map((property) => property?.name || property?.id || property))}

CRITICAL RULES:
1. ONLY output fields the user explicitly asked to change.
2. ONLY output a "property" field if the user clearly names one of the Available properties.
3. NEVER include null or empty values. Omit any field that should stay unchanged.
4. If the user says to change the date, use natural language like "today" or ISO YYYY-MM-DD in transactionDate. If only part of the date is given, follow the current-date combination rule above instead of guessing.${options.currentDraftSummary ? '\n5. If the request clearly describes a different transaction than the current one described above, follow the mismatch instructions above instead of guessing which field to patch.' : ''}

Return ONLY a JSON object with a top-level "patch" property containing only the fields that need to change (empty object if none, e.g. on a mismatch).
Allowed fields: type, amount, property, category, transactionDate, description.${options.currentDraftSummary ? '\nIf applicable, also include top-level "possibleMismatch" (boolean) and "mismatchNote" (string) as described above.' : ''}

Respond with valid JSON only and no markdown fences.
`.trim();

  try {
    const result = await aiService.completeJson({
      system: prompt,
      user: text,
      schemaHint: options.currentDraftSummary
        ? '{"patch":{"property":"Orchid","amount":"50000","transactionDate":"today"},"possibleMismatch":false,"mismatchNote":null}'
        : '{"patch":{"property":"Orchid","amount":"50000","transactionDate":"today"}}',
    });

    const patch = sanitizePatch(result?.patch && typeof result.patch === 'object' ? result.patch : {});
    const possibleMismatch = Boolean(result?.possibleMismatch);
    const mismatchNote =
      possibleMismatch && typeof result?.mismatchNote === 'string' && result.mismatchNote.trim()
        ? result.mismatchNote.trim()
        : null;

    return {
      patch: possibleMismatch ? {} : patch,
      parseResult: { aiUnavailable: false, source: 'ai', possibleMismatch, mismatchNote },
    };
  } catch (err) {
    console.error('[CorrectionPatch] Error building patch:', err);
    return {
      patch: {},
      parseResult: { aiUnavailable: true, source: 'ai' },
    };
  }
}

export function previewPatchValues(patch, referenceDate = new Date()) {
  const preview = { ...patch };
  if (preview.amount !== undefined) {
    preview.amount = normalizeAmount(preview.amount);
  }
  if (preview.transactionDate !== undefined) {
    preview.transactionDate = normalizeTransactionDate(preview.transactionDate, referenceDate);
  }
  return preview;
}

export default {
  buildCorrectionPatch,
  buildDeterministicPatch,
  sanitizePatch,
  previewPatchValues,
};
