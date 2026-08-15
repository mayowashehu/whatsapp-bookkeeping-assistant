import Entry from '../models/Entry.js';
import { formatNaira } from '../utils/currencyFormatter.js';
import { normalizeAmount, findPropertyInSourceText, normalizeTransactionDate, getLagosDateString } from '../ai/parsing/TransactionNormalizer.js';

// Shared by flagTransactionForReview.service.js, editConfirmedTransaction.service.js,
// and clearFlaggedTransaction.service.js — all three need to find the SAME
// confirmed entry from the same kind of free-text description ("the 20,000
// repairs payment for Flat 2"), so the search logic lives in exactly one
// place instead of three copies quietly drifting apart over time.

export function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function propertyNameOf(entry) {
  return entry?.property?.name || entry?.propertyName || 'Unknown property';
}

export function buildTransactionPreview(entry) {
  if (!entry) return null;
  const typeLabel = entry.type === 'income' ? 'income' : 'expense';
  const amount = formatNaira(entry.amount);
  const propertyName = propertyNameOf(entry);
  const date = formatDate(entry.transactionDate || entry.confirmedAt);
  const description = entry.description ? ` — ${entry.description}` : '';
  const flaggedTag = entry.flaggedForReview ? ' 🚩' : '';

  return `${typeLabel} ${amount} for ${propertyName}${date ? ` on ${date}` : ''}${description}${flaggedTag}`;
}

export function buildTransactionSnapshot(entry) {
  return {
    type: entry.type,
    amount: entry.amount,
    propertyName: propertyNameOf(entry),
    category: entry.category || null,
    description: entry.description || '',
    transactionDate: entry.transactionDate || entry.confirmedAt,
    flaggedForReview: Boolean(entry.flaggedForReview),
  };
}

// Matches a money amount anywhere in free text: currency-marked numbers of
// any size ("₦20,000", "naira 5000"), bare numbers with a k/m/b/thousand-
// style suffix ("20k", "1.5m"), comma-grouped numbers ("20,000",
// "1,234,567"), or bare runs of 3+ digits ("20000"). A bare 1-2 digit
// number is deliberately excluded — it's far more likely to be part of a
// date ("the 20th of July") than an amount.
const AMOUNT_CANDIDATE_PATTERN =
  /(?:₦|naira|ngn|#)\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:k|thousand|m|million|b|billion))?|\b\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|m|million|b|billion)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b/gi;

export function extractAmountFromText(text) {
  const matches = String(text || '').match(AMOUNT_CANDIDATE_PATTERN) || [];
  for (const raw of matches) {
    const amount = normalizeAmount(raw);
    if (amount !== null) return amount;
  }
  return null;
}

/**
 * Pulls a best-effort search signal (amount, property) out of free text
 * describing a transaction. Never guesses beyond what's actually in the
 * text — a field that can't be confidently read is left null rather than
 * assumed, same principle as TransactionParser.
 */
export function extractSearchCriteria(text, knownProperties = []) {
  const amount = extractAmountFromText(text);
  const propertyResolution = findPropertyInSourceText(text, knownProperties);
  return { amount, propertyResolution };
}

/**
 * Finds confirmed entries matching an amount and/or property, most recent
 * first. Used to locate the specific entry a flag/edit/clear request is
 * about — never guesses which one the user means beyond narrowing by what
 * they actually said.
 */
export async function findConfirmedMatches({ senderId, amount, propertyId, extraMatch = {}, limit = 6 }) {
  const query = { senderId, status: 'confirmed', ...extraMatch };
  if (amount !== null && amount !== undefined) {
    query.amount = amount;
  }
  if (propertyId) {
    query.property = propertyId;
  }
  return Entry.find(query)
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(limit)
    .populate('property', 'name')
    .lean();
}

// Task 3.3 follow-up — when a search turns up more than one entry, the
// candidate list needs to survive to the NEXT message so a natural
// disambiguating reply ("the one from August 1st", "the diesel one", "1")
// can actually resolve it, instead of forcing the user to restate the
// whole request with more detail from scratch. These candidates are
// lightweight (not full Mongo docs) so they can be stored directly on a
// pending-state document and matched against later without a re-query.

export function buildCandidateList(entries) {
  return entries.map((entry) => ({
    entryId: String(entry._id),
    type: entry.type,
    amount: entry.amount,
    propertyName: propertyNameOf(entry),
    category: entry.category || null,
    description: entry.description || '',
    transactionDate: entry.transactionDate || entry.confirmedAt || null,
  }));
}

export function buildCandidatePreview(candidate) {
  if (!candidate) return null;
  const typeLabel = candidate.type === 'income' ? 'income' : 'expense';
  const amount = formatNaira(candidate.amount);
  const date = formatDate(candidate.transactionDate);
  const description = candidate.description ? ` — ${candidate.description}` : '';
  return `${typeLabel} ${amount} for ${candidate.propertyName}${date ? ` on ${date}` : ''}${description}`;
}

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

/**
 * Tries to narrow a stored candidate list down to exactly one entry using
 * whatever the user just said, in order of specificity:
 *   1. An explicit pick — "1", "the first one", "option 2", "number 3"
 *   2. A date mentioned in the text, matched against each candidate's day
 *   3. A keyword from the text found in a candidate's description
 * Never guesses beyond what's actually said — if nothing narrows it down,
 * the original (or partially narrowed) list is returned unchanged rather
 * than picking one arbitrarily.
 */
export function narrowCandidatesByText(candidates, text, referenceDate = new Date()) {
  const list = Array.isArray(candidates) ? candidates : [];
  const clean = String(text || '').trim();
  if (!clean || list.length === 0) {
    return { matched: null, candidates: list };
  }
  const lower = clean.toLowerCase();

  // Date check runs BEFORE bare-number selection. A phrase like "the one
  // with the date of August 1" contains a bare "1" that a number-selection
  // check would misread as "pick candidate #1" — an actual bug caught by
  // testing this exact phrasing. normalizeTransactionDate only resolves
  // text that genuinely reads as a date (a bare "1" or "2" on its own
  // returns null), so trying it first is safe for plain number replies too.
  const ymd = normalizeTransactionDate(clean, referenceDate);
  if (ymd) {
    const filtered = list.filter((candidate) => {
      if (!candidate.transactionDate) return false;
      return getLagosDateString(new Date(candidate.transactionDate)) === ymd;
    });
    if (filtered.length === 1) return { matched: filtered[0], candidates: filtered };
    if (filtered.length > 1) return { matched: null, candidates: filtered };
  }

  const numberMatch = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (numberMatch) {
    const idx = parseInt(numberMatch[1], 10) - 1;
    if (idx >= 0 && idx < list.length) {
      return { matched: list[idx], candidates: [list[idx]] };
    }
  }
  for (let i = 0; i < ORDINAL_WORDS.length; i += 1) {
    if (new RegExp(`\\b${ORDINAL_WORDS[i]}\\b`).test(lower) && i < list.length) {
      return { matched: list[i], candidates: [list[i]] };
    }
  }

  const words = lower.split(/\s+/).filter((word) => word.length > 2);
  if (words.length > 0) {
    const filtered = list.filter((candidate) => {
      const haystack = `${candidate.description || ''} ${candidate.category || ''}`.toLowerCase();
      return words.some((word) => haystack.includes(word));
    });
    if (filtered.length === 1) return { matched: filtered[0], candidates: filtered };
    if (filtered.length > 0 && filtered.length < list.length) return { matched: null, candidates: filtered };
  }

  return { matched: null, candidates: list };
}

export default {
  formatDate,
  propertyNameOf,
  buildTransactionPreview,
  buildTransactionSnapshot,
  extractAmountFromText,
  extractSearchCriteria,
  findConfirmedMatches,
  buildCandidateList,
  buildCandidatePreview,
  narrowCandidatesByText,
};
