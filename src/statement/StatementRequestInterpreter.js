import {
  MONTHS,
  getLagosDateString,
  resolveProperty,
} from '../ai/parsing/TransactionNormalizer.js';

/**
 * Extracts property / month / year for a STATEMENT_REQUEST.
 * Reuses existing property matching and month name tables — no duplicated parsers.
 *
 * @returns {{
 *   property: { id: string, name: string }|null,
 *   propertyStatus: 'matched'|'none'|'ambiguous'|'missing',
 *   propertyCandidates: Array<{ id: string, name: string }>,
 *   unmatchedProperty: string|null,
 *   month: number|null,
 *   year: number|null,
 *   missingFields: string[],
 *   clarificationQuestion: string|null
 * }}
 */
export function interpretStatementRequest(text, { knownProperties = [], referenceDate = new Date() } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');

  const propertyResult = matchKnownProperty(lower, knownProperties);
  const { month, year } = detectMonthYear(lower, referenceDate);

  const missingFields = [];
  if (propertyResult.status === 'missing' || propertyResult.status === 'none') {
    missingFields.push('property');
  }
  if (propertyResult.status === 'ambiguous') {
    missingFields.push('property');
  }
  if (!month) {
    missingFields.push('month');
  }
  if (!year) {
    missingFields.push('year');
  }

  return {
    property: propertyResult.property,
    propertyStatus: propertyResult.status,
    propertyCandidates: propertyResult.candidates,
    unmatchedProperty: propertyResult.unmatchedProperty,
    month,
    year,
    missingFields: [...new Set(missingFields)],
    clarificationQuestion: buildClarificationQuestion({
      missingFields: [...new Set(missingFields)],
      propertyStatus: propertyResult.status,
      propertyCandidates: propertyResult.candidates,
      unmatchedProperty: propertyResult.unmatchedProperty,
      knownProperties,
    }),
  };
}

/**
 * Single source of truth for matching free text against known properties.
 * Used both for the initial statement request parse AND for the follow-up
 * turn when the bot is only waiting on the property name. Previously
 * StatementRequestService.js had its own weaker exact-match-only copy of
 * this logic for the follow-up turn — that duplication is now removed;
 * both call sites use this function so behavior can't drift between them.
 */
export function matchKnownProperty(text, knownProperties) {
  const lower = typeof text === 'string' ? text.toLowerCase().trim() : '';
  if (!lower) {
    return { property: null, status: 'missing', candidates: [], unmatchedProperty: null };
  }

  // 1. Bare exact reply — the whole message IS just the property name, e.g.
  // a follow-up answer like "Flat 2" with nothing else in the message.
  const exact = (knownProperties || []).find(
    (p) => String(p.name).toLowerCase().trim() === lower,
  );
  if (exact) {
    return {
      property: { id: String(exact.id), name: exact.name },
      status: 'matched',
      candidates: [],
      unmatchedProperty: null,
    };
  }

  // 2. Extract the bounded "for X" mention and resolve it STRICTLY (exact
  // canonicalized match against a known name/alias — see resolveProperty).
  // This must run before any loose whole-message scan: a phrase like
  // "statement for Orchid House" must not silently collapse onto the known
  // property "Orchid" just because "orchid" happens to be a substring of
  // "orchid house" — that's a different (unknown) property, and guessing
  // wrong here means generating and sending the wrong statement.
  const mention = extractPropertyMention(lower);
  if (mention) {
    const resolved = resolveProperty(mention, knownProperties);
    if (resolved.status === 'matched') {
      return {
        property: resolved.property,
        status: 'matched',
        candidates: [],
        unmatchedProperty: null,
      };
    }
    if (resolved.status === 'ambiguous') {
      return {
        property: null,
        status: 'ambiguous',
        candidates: resolved.candidates,
        unmatchedProperty: mention,
      };
    }
    return {
      property: null,
      status: 'none',
      candidates: [],
      unmatchedProperty: mention,
    };
  }

  // 3. Last resort only: no "for X" clause to extract from at all (e.g.
  // "Orchid statement please" with no "for"). Fall back to a word-boundary
  // scan of the whole message, preferring the longest known label found.
  // Deliberately permissive since there's no other candidate text to work
  // with here, but scoped narrower than before (word-boundary, not raw
  // substring) and only reached once options 1-2 have both failed.
  let best = null;
  for (const property of knownProperties || []) {
    const labels = [property.name, ...(property.aliases || [])];
    for (const label of labels) {
      const needle = String(label || '').toLowerCase().trim();
      if (!needle) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i');
      if (pattern.test(lower) && (!best || needle.length > best.len)) {
        best = { id: String(property.id), name: property.name, len: needle.length };
      }
    }
  }
  if (best) {
    return {
      property: { id: best.id, name: best.name },
      status: 'matched',
      candidates: [],
      unmatchedProperty: null,
    };
  }

  return {
    property: null,
    status: 'missing',
    candidates: [],
    unmatchedProperty: null,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FIX (§6a, 🟠): "statement for Orchid for June" broke property matching.
// extractPropertyMention's fallback regex (`/\bfor\s+(.+)$/i`) greedily
// captures everything after the FIRST "for" to the end of the string —
// for this message, that's "orchid for june". Month names get stripped
// (leaving "orchid for"), but "for" itself was never in the noise-word
// list, so the leftover "orchid for" is what actually gets looked up
// against known properties — which of course never matches, even though
// "Orchid" is an exact, already-registered property. Mentioning both the
// property and the period in one sentence is a completely natural way to
// ask for a statement, so this isn't a rare edge case.
//
// Fix: add "for" itself to the noise-word strip list, applied AFTER the
// first "for" has already been consumed by the outer match. This only
// strips a literal whole-word "for" — a property named e.g. "Fort James"
// is untouched, since \bfor\b requires "for" as its own word, not a
// prefix of "fort".
const MENTION_NOISE_WORDS = /\b(statement|report|pdf|month|the|please|now|thanks|kindly|for)\b/gi;

// FIX (follow-up to §6a): "generate monthly report for orchid for this
// month" broke property matching a second way. beforeTrigger's
// trigger-word list includes bare "month" (to catch rarer phrasings like
// "Orchid month report"), but that collides with "this month"/"last
// month" as part of an ordinary period phrase elsewhere in the same
// sentence — the non-greedy capture keeps expanding past "orchid for"
// looking for its next trigger word, and finds one at the "month" in
// "this month", so it grabs "orchid for this" as the property mention.
//
// Fix: mask out "this/last/current/next/every month" BEFORE running the
// trigger-word patterns, so that "month" is no longer sitting there as a
// false trigger. Once masked, beforeTrigger correctly fails to match
// (nothing left to trigger on) and falls through to the afterFor path,
// which already knows how to strip a dangling "for" — the exact mechanism
// §6a introduced for the sibling case "statement for Orchid for June".
const PERIOD_MONTH_QUALIFIER = /\b(this|last|current|next|every)\s+month\b/gi;

function extractPropertyMention(lower) {
  const maskedForPropertySearch = lower.replace(PERIOD_MONTH_QUALIFIER, ' ');

  // Explicit "apartment X" / "apt X" / "property X" style mentions take priority.
  const explicitUnit = /\b((?:apartment|apt|property)\s+[a-z0-9]+)\b/i.exec(maskedForPropertySearch);
  if (explicitUnit) {
    return explicitUnit[1].trim();
  }

  // "for <name> statement" (name before the trigger word) — original pattern.
  const beforeTrigger = /\bfor\s+([a-z0-9][a-z0-9\s]{0,40}?)\s+(?:statement|report|pdf|month)\b/i.exec(maskedForPropertySearch);
  if (beforeTrigger) {
    return beforeTrigger[1].trim();
  }

  // Fallback: "statement for <name>" (name AFTER "for", to end of string) —
  // covers word orders the pattern above misses, e.g. "Send July statement
  // for Orchid House". Strip noise words and any month/year tokens so we
  // don't hand back a garbled multi-word chunk of the whole sentence.
  const afterFor = /\bfor\s+(.+)$/i.exec(maskedForPropertySearch);
  if (afterFor) {
    let candidate = afterFor[1].replace(MENTION_NOISE_WORDS, ' ');
    for (const token of Object.keys(MONTHS)) {
      candidate = candidate.replace(new RegExp(`\\b${token}\\b`, 'gi'), ' ');
    }
    candidate = candidate.replace(/\b(20\d{2})\b/g, ' ');
    candidate = candidate.replace(/\s+/g, ' ').trim();
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function detectMonthYear(lower, referenceDate) {
  const todayStr = getLagosDateString(referenceDate);
  const todayYear = Number(todayStr.slice(0, 4));
  const todayMonth = Number(todayStr.slice(5, 7));

  if (/\btoday\b/.test(lower)) {
    return { month: todayMonth, year: todayYear };
  }

  if (/\byesterday\b/.test(lower)) {
    const yesterday = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000);
    const yStr = getLagosDateString(yesterday);
    return { month: Number(yStr.slice(5, 7)), year: Number(yStr.slice(0, 4)) };
  }

  if (/\bthis month\b/.test(lower) || /\bcurrent month\b/.test(lower)) {
    return { month: todayMonth, year: todayYear };
  }

  if (/\blast month\b/.test(lower)) {
    // Roll back one calendar month, wrapping the year at January.
    const lastMonth = todayMonth === 1 ? 12 : todayMonth - 1;
    const lastMonthYear = todayMonth === 1 ? todayYear - 1 : todayYear;
    return { month: lastMonth, year: lastMonthYear };
  }

  let month = null;
  let year = null;

  // Year: "this year"/"current year" resolve immediately; otherwise look for
  // an explicit 4-digit year OR "last year".
  if (/\bthis year\b/.test(lower) || /\bcurrent year\b/.test(lower)) {
    year = todayYear;
  } else if (/\blast year\b/.test(lower)) {
    year = todayYear - 1;
  } else {
    const yearMatch = /\b(20\d{2})\b/.exec(lower);
    if (yearMatch) {
      year = Number(yearMatch[1]);
    }
  }

  for (const [token, value] of Object.entries(MONTHS)) {
    const re = new RegExp(`\\b${token}\\b`, 'i');
    if (re.test(lower)) {
      month = value;
      break;
    }
  }

  // Numeric month: "month 7" / "07/2026" / "2026-07"
  if (!month) {
    const iso = /\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/.exec(lower);
    if (iso) {
      year = Number(iso[1]);
      month = Number(iso[2]);
    }
  }

  if (!month) {
    const numbered = /\bmonth\s+(0?[1-9]|1[0-2])\b/.exec(lower);
    if (numbered) {
      month = Number(numbered[1]);
    }
  }

  return { month, year };
}

export function buildClarificationQuestion({
  missingFields,
  propertyStatus,
  propertyCandidates,
  unmatchedProperty,
  knownProperties = [],
}) {
  const knownNames = (knownProperties || []).map((p) => p.name).filter(Boolean);
  const knownList = knownNames.length ? ` Your known properties are: ${knownNames.join(', ')}.` : '';

  if (propertyStatus === 'ambiguous' && propertyCandidates?.length > 1) {
    const names = propertyCandidates.map((p) => p.name).join(' or ');
    return `Which property should I use for the statement: ${names}?`;
  }

  // L: a friendlier, accurate recovery message. Statements can only cover a
  // property that already has transaction history, so — unlike a new
  // transaction — we can't just offer to create the property on the spot
  // and generate an (empty) statement for it. Instead: point at what IS on
  // file, and explain the one legitimate path to a new property.
  if (propertyStatus === 'none' && unmatchedProperty) {
    return `I don't have "${unmatchedProperty}" saved as a property yet.${knownList} Which one should I use for this statement? (If it's a genuinely new property, log a transaction for it first — that's what adds it to your list — then ask for the statement again.)`;
  }

  if (missingFields.includes('property') && (missingFields.includes('month') || missingFields.includes('year'))) {
    return `Which property, and which month/year, should the statement cover?${knownList}`;
  }

  if (missingFields.includes('property')) {
    return `Which property should I generate the statement for?${knownList}`;
  }

  if (missingFields.includes('month') && missingFields.includes('year')) {
    return 'Which month and year should the statement cover?';
  }

  if (missingFields.includes('month')) {
    return 'Which month should the statement cover?';
  }

  if (missingFields.includes('year')) {
    return 'Which year should the statement cover?';
  }

  return null;
}

export default {
  interpretStatementRequest,
  matchKnownProperty,
  buildClarificationQuestion,
};