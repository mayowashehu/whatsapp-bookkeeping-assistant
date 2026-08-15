import Entry from '../models/Entry.js';

// PROJECT_CONTEXT.md, "Duplicate Detection":
//   "If a transaction looks almost identical to one saved recently, the
//   assistant should ask: 'This looks similar to a transaction you
//   recently logged. Save another one?'"
//
// "Almost identical" is read here as same property + same amount + same
// type (income/expense) — the three fields that define a transaction's
// identity in this app. Category/description are deliberately excluded:
// two entries can have the same amount+property but different categories
// and still be exactly the kind of accidental double-entry this feature
// exists to catch (e.g. resending "Paid 20k for repairs at Flat 2" a
// second time, where the AI happened to file it under a slightly
// different category word each time).
//
// "Recently" is a 24-hour window anchored on confirmedAt (when it was
// SAVED, not the transaction's own date) — this catches "I already told
// you about this earlier today" without flagging a legitimately recurring
// transaction (e.g. the same rent amount logged monthly) which won't fall
// inside a same-day window.
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A stable string identity for a draft's core fields, used to remember
 * "the user already saw and accepted a duplicate warning for exactly this
 * transaction." If the draft is corrected afterwards (different amount,
 * property, or type), the fingerprint changes and the warning is free to
 * fire again on the next confirmation attempt — no separate reset logic
 * needed anywhere else.
 */
export function buildDuplicateFingerprint({ type, propertyId, amount }) {
  if (!type || !propertyId || amount === null || amount === undefined) return null;
  return `${String(type).toLowerCase()}|${String(propertyId)}|${Number(amount)}`;
}

/**
 * Looks for a recently-confirmed entry that matches on type + property +
 * amount. Returns the match (populated with property name) or null. Never
 * used to block a save outright — only to trigger one extra confirmation
 * step, consistent with this app's "ask before acting" pattern elsewhere.
 */
export async function findLikelyDuplicateEntry({
  senderId,
  type,
  propertyId,
  amount,
  referenceDate = new Date(),
  windowMs = DUPLICATE_WINDOW_MS,
}) {
  if (!senderId || !type || !propertyId || amount === null || amount === undefined) {
    return null;
  }

  const cutoff = new Date(referenceDate.getTime() - windowMs);

  return Entry.findOne({
    senderId,
    status: 'confirmed',
    type,
    property: propertyId,
    amount,
    confirmedAt: { $gte: cutoff },
  })
    .sort({ confirmedAt: -1 })
    .populate('property', 'name')
    .lean();
}

export default {
  buildDuplicateFingerprint,
  findLikelyDuplicateEntry,
};
