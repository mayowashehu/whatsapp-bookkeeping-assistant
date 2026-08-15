import * as chrono from 'chrono-node';

const WEEKDAYS = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

export const MONTHS = Object.freeze({
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
});

export function getLagosDateString(referenceDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function parseIsoDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidYmd(year, month, day)) return null;
  return formatYmd(year, month, day);
}

function isValidYmd(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDaysToYmd(ymd, deltaDays) {
  const [year, month, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return formatYmd(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

function weekdayIndex(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseWithChrono(value, referenceDate) {
  try {
    const parsed = chrono.parseDate(value, referenceDate);
    if (!parsed || Number.isNaN(parsed.getTime())) return null;
    return getLagosDateString(parsed);
  } catch {
    return null;
  }
}

export function normalizeTransactionDate(value, referenceDate = new Date()) {
  if (value === null || value === undefined) return null;

  let text = String(value)
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bof\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const today = getLagosDateString(referenceDate);
  if (text === 'today') return today;
  if (text === 'yesterday') return addDaysToYmd(today, -1);
  if (text === 'tomorrow') return addDaysToYmd(today, 1);

  const iso = parseIsoDateOnly(text);
  if (iso) return iso;

  const weekdayMatch = /^(?:last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text);
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1]);
    const current = weekdayIndex(today);
    let delta = (current - target + 7) % 7;
    if (delta === 0) delta = 7;
    return addDaysToYmd(today, -delta);
  }

  const dayMonth = /^(\d{1,2})\s+([a-z]+)$/.exec(text);
  if (dayMonth) return resolveDayMonth(Number(dayMonth[1]), dayMonth[2], today);

  const monthDay = /^([a-z]+)\s+(\d{1,2})$/.exec(text);
  if (monthDay) return resolveDayMonth(Number(monthDay[2]), monthDay[1], today);

  const chronoDate = parseWithChrono(text, referenceDate);
  if (chronoDate) return chronoDate;

  return null;
}

function resolveDayMonth(day, monthToken, todayYmd) {
  const month = MONTHS[monthToken];
  if (!month) return null;

  let year = Number(todayYmd.slice(0, 4));
  if (!isValidYmd(year, month, day)) return null;

  const targetDate = formatYmd(year, month, day);
  if (targetDate > todayYmd) {
    year -= 1;
    if (!isValidYmd(year, month, day)) return null;
    return formatYmd(year, month, day);
  }

  return targetDate;
}

export function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  let text = String(value).trim().toLowerCase();
  text = text.replace(/ngn/g, '').replace(/₦/g, '').replace(/,/g, '').replace(/\s+/g, '');

  if (!text) return null;

  const kMatch = /^(\d+(?:\.\d+)?)k$/.exec(text);
  if (kMatch) {
    const amount = Number(kMatch[1]) * 1000;
    return amount > 0 ? amount : null;
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const amount = Number(text);
  return amount > 0 ? amount : null;
}

export function canonicalizePropertyLabel(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const NUMBER_WORDS = Object.freeze({
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
});

export function propertyMatchKeys(value) {
  const raw = String(value || '').toLowerCase();
  const keys = new Set();

  const compact = canonicalizePropertyLabel(raw);
  if (compact) keys.add(compact);

  let withNumberWords = raw;
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    withNumberWords = withNumberWords.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }

  const compactNumbers = canonicalizePropertyLabel(withNumberWords);
  if (compactNumbers) keys.add(compactNumbers);

  for (const key of [...keys]) {
    if (key.includes('apartment')) keys.add(key.replace(/apartment/g, 'apt'));
    if (key.startsWith('apt') && !key.startsWith('apartment')) {
      keys.add(`apartment${key.slice(3)}`);
    }
  }

  return [...keys].filter(Boolean);
}

// Canonical order in which a missing field should be asked about. `amount`
// is deliberately ahead of `property`: once the user has said *something*
// that pins down type (a verb like "paid"/"received", or a fully-resolved
// AI extraction), "how much?" is the single most useful next question —
// asking for the property first, before we even know the size of the
// transaction, reads as an arbitrary/generic prompt rather than a natural
// follow-up. See ClarificationService.generateClarificationQuestion, which
// always picks fields[0] as the question to ask.
const MISSING_FIELD_PRIORITY = ['type', 'amount', 'property', 'category', 'transactionDate'];

export function sortMissingFieldsByPriority(fields = []) {
  const list = Array.isArray(fields) ? fields : [];
  return [...list].sort((a, b) => {
    const ai = MISSING_FIELD_PRIORITY.indexOf(a);
    const bi = MISSING_FIELD_PRIORITY.indexOf(b);
    return (ai === -1 ? MISSING_FIELD_PRIORITY.length : ai) - (bi === -1 ? MISSING_FIELD_PRIORITY.length : bi);
  });
}

// Lightweight, local (non-AI) verb heuristic used only as a last-resort
// fallback when the AI extraction layer returns zero transaction skeletons
// at all (e.g. a bare "Paid" with nothing else to latch onto). Lets the
// fallback clarification question still ask "How much was paid?" instead of
// the type-agnostic "Is this an Income or an Expense?" when the very word
// the user sent already answers that.
const EXPENSE_VERB_HINT = /\b(paid|pay|pays|paying|spent|spend|spends|spending|bought|buy|buys|buying|purchase[ds]?|purchasing)\b/i;
const INCOME_VERB_HINT = /\b(received|receive[ds]?|receiving|got|collect(?:ed|ing|s)?|earned|earn(?:ing|s)?)\b/i;

export function inferTypeFromText(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (EXPENSE_VERB_HINT.test(clean)) return 'expense';
  if (INCOME_VERB_HINT.test(clean)) return 'income';
  return null;
}

export function getPropertyId(property) {
  if (!property) return null;
  if (property.id) return String(property.id);
  if (property._id) return String(property._id);
  return null;
}

// FIX (§4b, 🔵): findPropertyInSourceText() used to track a single running
// "best match" (bestMatch/bestLen) across ALL labels of ALL properties. On
// a true tie — two distinct properties whose best-matching label is the
// same length — the property scanned first silently won, and the function
// could only ever return 'matched' or 'none'. resolveProperty() already
// has a full 'ambiguous' contract (status + candidates) that the rest of
// the pipeline understands (normalizeTransactionFields pushes 'property'
// into missingFields and notes 'ambiguous_property' for it) — this path
// just never used it.
//
// Now the best label-match length is tracked PER PROPERTY (so a property
// matched via multiple aliases still only counts once), then compared
// across properties. A single property with a strictly longer match still
// wins outright and is returned as 'matched' — this is what correctly
// resolves "Orchid" vs "Orchid Annex" when the message says "...at the
// Orchid Annex guest room...": Orchid Annex's match (12 chars) beats
// Orchid's (6 chars), so it's unambiguous, exactly as before. Only a
// genuine tie between two or more DISTINCT properties now surfaces as
// 'ambiguous' instead of being resolved by silent scan order.
export function findPropertyInSourceText(sourceText, knownProperties = []) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    return { property: null, status: 'none', candidates: [] };
  }

  const text = sourceText.toLowerCase();
  const bestLenByPropertyId = new Map();
  const propertyById = new Map();

  for (const property of (knownProperties || []).filter((p) => p && p.active !== false)) {
    const labels = [property.name, ...(property.aliases || [])].filter(Boolean);
    let bestLenForThisProperty = 0;

    for (const label of labels) {
      const labelLower = String(label).toLowerCase().trim();
      if (!labelLower || labelLower.length < 2) continue;

      const pattern = new RegExp(`\\b${escapeRegExp(labelLower)}\\b`, 'i');
      if (pattern.test(text) && labelLower.length > bestLenForThisProperty) {
        bestLenForThisProperty = labelLower.length;
      }
    }

    if (bestLenForThisProperty > 0) {
      const id = getPropertyId(property);
      bestLenByPropertyId.set(id, bestLenForThisProperty);
      propertyById.set(id, property);
    }
  }

  if (bestLenByPropertyId.size === 0) {
    return { property: null, status: 'none', candidates: [] };
  }

  const maxLen = Math.max(...bestLenByPropertyId.values());
  const topCandidates = [...bestLenByPropertyId.entries()]
    .filter(([, len]) => len === maxLen)
    .map(([id]) => ({ id, name: propertyById.get(id).name }));

  if (topCandidates.length === 1) {
    return { property: topCandidates[0], status: 'matched', candidates: topCandidates };
  }

  return { property: null, status: 'ambiguous', candidates: topCandidates };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Audit fix: typo-tolerant property matching --------------------------
// Previously resolveProperty only ever did an exact (canonicalized) match.
// A one-letter typo like "Orhcid" (transposed) or "Orchdi" (transposed)
// found ZERO match against a real "Orchid" property — it fell straight
// through to being treated as a brand-new property name, which the app
// would then silently offer to create. That's the wrong failure mode: a
// misspelling of an existing property should resolve TO that property (and
// show up correctly in the draft the user reviews before confirming — see
// DraftFormatter's confirmation message, which already displays the real
// resolved property name), not spawn a new, wrong one.
//
// This is deliberately conservative — it must never SILENTLY reassign a
// transaction to the wrong property:
//   - It only runs when no exact match was found at all (never overrides a
//     real match or a real ambiguous-match result).
//   - It requires any digits in the mention to match a candidate's digits
//     EXACTLY — "Flat 2" vs "Flat 3" is a one-character edit distance but
//     a completely different property, not a typo, so digit mismatches are
//     never bridged.
//   - It uses Damerau-Levenshtein distance (substitutions, insertions,
//     deletions, and adjacent-letter transpositions — the single most
//     common real typo shape) with a tight, length-scaled threshold.
//   - If more than one known property ties for the closest distance, it
//     refuses to guess and reports them as ambiguous candidates instead —
//     same "never guess" contract the exact-match path already has.
export function damerauLevenshteinDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i += 1) d[i][0] = i;
  for (let j = 0; j <= bl; j += 1) d[0][j] = j;

  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // transposition
      }
    }
  }

  return d[al][bl];
}

function extractDigitSignature(compactKey) {
  return (compactKey.match(/\d+/g) || []).join(',');
}

function fuzzyDistanceThreshold(len) {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

function findFuzzyPropertyMatch(mention, active) {
  const compactMention = canonicalizePropertyLabel(mention);
  // Too short for a meaningful fuzzy comparison — e.g. "A" is within edit
  // distance 1 of almost anything, which would be worse than useless.
  if (!compactMention || compactMention.length < 3) {
    return { property: null, candidates: [] };
  }

  const mentionDigits = extractDigitSignature(compactMention);
  const threshold = fuzzyDistanceThreshold(compactMention.length);

  const scoredById = new Map();
  for (const property of active) {
    const labels = [property.name, ...(property.aliases || [])].filter(Boolean);
    let bestDistanceForProperty = Infinity;

    for (const label of labels) {
      const compactLabel = canonicalizePropertyLabel(label);
      if (!compactLabel) continue;
      // Never bridge an actual digit difference — that names a different
      // unit, not a misspelling of this one.
      if (extractDigitSignature(compactLabel) !== mentionDigits) continue;

      const distance = damerauLevenshteinDistance(compactMention, compactLabel);
      if (distance < bestDistanceForProperty) bestDistanceForProperty = distance;
    }

    if (bestDistanceForProperty <= threshold) {
      const id = getPropertyId(property);
      const existing = scoredById.get(id);
      if (!existing || bestDistanceForProperty < existing.distance) {
        scoredById.set(id, { id, name: property.name, distance: bestDistanceForProperty });
      }
    }
  }

  if (scoredById.size === 0) {
    return { property: null, candidates: [] };
  }

  const scored = [...scoredById.values()].sort((a, b) => a.distance - b.distance);
  const bestDistance = scored[0].distance;
  const top = scored.filter((s) => s.distance === bestDistance).map(({ id, name }) => ({ id, name }));

  return { property: top.length === 1 ? top[0] : null, candidates: top };
}

export function resolveProperty(mention, knownProperties = []) {
  const needles = new Set(propertyMatchKeys(mention));
  if (needles.size === 0) return { property: null, status: 'none', candidates: [] };

  const active = (knownProperties || []).filter((p) => p && p.active !== false);
  const matches = [];

  for (const property of active) {
    const labels = [property.name, ...(property.aliases || [])];
    const labelKeys = new Set(labels.flatMap((label) => propertyMatchKeys(label)));
    const overlapped = [...needles].some((needle) => labelKeys.has(needle));
    if (overlapped) {
      matches.push({ id: getPropertyId(property), name: property.name });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    if (!seen.has(match.id)) {
      seen.add(match.id);
      unique.push(match);
    }
  }

  if (unique.length === 1) {
    return { property: unique[0], status: 'matched', candidates: unique };
  }
  if (unique.length > 1) {
    return { property: null, status: 'ambiguous', candidates: unique };
  }

  // No exact match at all — try a conservative typo-tolerant match before
  // giving up (see findFuzzyPropertyMatch above for the exact safety rules).
  const fuzzy = findFuzzyPropertyMatch(mention, active);
  if (fuzzy.property) {
    return { property: fuzzy.property, status: 'matched', candidates: fuzzy.candidates };
  }
  if (fuzzy.candidates.length > 1) {
    return { property: null, status: 'ambiguous', candidates: fuzzy.candidates };
  }

  return { property: null, status: 'none', candidates: [] };
}

export function normalizeTransactionFields(raw, { knownProperties = [], sourceText = '', referenceDate = new Date() } = {}) {
  const missingFields = [];
  const notes = [];

  const typeRaw = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  let type = null;
  if (typeRaw === 'income' || typeRaw === 'expense') type = typeRaw;
  else missingFields.push('type');

  const explicitPropertyMention = typeof raw.property === 'string' ? raw.property.trim() : '';

  let propertyResolution;
  if (explicitPropertyMention) {
    propertyResolution = resolveProperty(explicitPropertyMention, knownProperties);
  } else if (sourceText) {
    propertyResolution = findPropertyInSourceText(sourceText, knownProperties);
    if (propertyResolution.status === 'none') {
      propertyResolution = resolveProperty('', knownProperties);
    }
  } else {
    propertyResolution = resolveProperty('', knownProperties);
  }

  let property = null;
  let pendingNewPropertyName = null;

  if (propertyResolution.status === 'matched') {
    property = propertyResolution.property.id;
  } else if (propertyResolution.status === 'ambiguous') {
    missingFields.push('property');
    notes.push('ambiguous_property');
  } else if (explicitPropertyMention) {
    pendingNewPropertyName = explicitPropertyMention;
  } else {
    missingFields.push('property');
  }

  const amount = normalizeAmount(raw.amount);
  if (amount === null) missingFields.push('amount');

  let category = null;
  if (type === 'income') {
    category = null;
  } else if (type === 'expense') {
    const categoryRaw =
      typeof raw.category === 'string'
        ? raw.category.trim()
        : raw.category === null || raw.category === undefined
          ? ''
          : String(raw.category).trim();
    if (!categoryRaw) missingFields.push('category');
    else category = categoryRaw;
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const dateRaw = typeof raw.transactionDate === 'string' ? raw.transactionDate.trim() : '';
  let transactionDate = null;
  if (!dateRaw) {
    transactionDate = getLagosDateString(referenceDate);
  } else {
    transactionDate = normalizeTransactionDate(dateRaw, referenceDate);
    if (!transactionDate) {
      missingFields.push('transactionDate');
      notes.push('unparseable_date');
    }
  }

  const uniqueMissing = sortMissingFieldsByPriority([...new Set(missingFields)]);

  return {
    draft: {
      type: type || '',
      property,
      pendingNewPropertyName,
      amount,
      category,
      description,
      transactionDate: transactionDate || '',
      sourceText: sourceText || '',
    },
    missingFields: uniqueMissing,
    propertyCandidates: propertyResolution.candidates,
    pendingNewPropertyName,
    notes,
    aiClarificationRequired: Boolean(raw.clarificationRequired),
    aiMissingFields: Array.isArray(raw.missingFields) ? raw.missingFields : [],
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '',
  };
}

export default {
  normalizeTransactionFields,
  normalizeAmount,
  normalizeTransactionDate,
  resolveProperty,
  findPropertyInSourceText,
  getPropertyId,
  getLagosDateString,
  addDaysToYmd,
  canonicalizePropertyLabel,
  sortMissingFieldsByPriority,
  inferTypeFromText,
  MONTHS,
  damerauLevenshteinDistance,
};