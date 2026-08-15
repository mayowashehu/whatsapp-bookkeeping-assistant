import { formatNaira } from '../../utils/currencyFormatter.js';
import { buildTransactionPreview } from '../transactionLookup.js';

// Canonical home for "preview a not-yet-drafted transaction" formatting.
// Used both by messageHandlerShared.js's multi-item notice (previewing all
// detected items up front) and by DraftManager.js when it advances to the
// next queued item after the current one is saved — kept in one place so
// the two surfaces can't drift out of sync with each other.
export function formatAmount(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (numeric === null) {
    return '(amount pending)';
  }
  try {
    return `₦${numeric.toLocaleString('en-NG')}`;
  } catch {
    return `₦${numeric.toString()}`;
  }
}

// A matched property normalizes to its database ID (see
// TransactionNormalizer.normalizeTransactionFields), not its name — so
// without a lookup, previews would show a raw Mongo ObjectId string like
// "64f...b2" instead of "Orchid". Also falls through to
// "(unknown property)" for a genuinely new/unmatched property even though
// pendingNewPropertyName already holds the free-text name the user typed.
export function resolvePropertyDisplayName(tx, knownProperties = []) {
  if (tx?.pendingNewPropertyName) {
    return String(tx.pendingNewPropertyName).trim();
  }
  if (typeof tx?.property === 'string' && tx.property.trim()) {
    const match = (knownProperties || []).find((property) => {
      const id = property?.id ?? property?._id;
      return id !== undefined && id !== null && String(id) === tx.property;
    });
    if (match?.name) return match.name;
    return tx.property.trim();
  }
  if (tx?.propertyName) {
    return String(tx.propertyName);
  }
  return null;
}

export function formatTransactionPreview(tx, knownProperties = []) {
  if (!tx || typeof tx !== 'object') {
    return '—';
  }

  const type = tx.type === 'income' ? 'Income' : tx.type === 'expense' ? 'Expense' : 'Transaction';
  const amount = formatAmount(tx.amount);
  const property = resolvePropertyDisplayName(tx, knownProperties) || '(unknown property)';
  const category =
    tx.type === 'income' || !tx.category || !String(tx.category).trim()
      ? ''
      : ` (${String(tx.category).trim()})`;
  const description =
    typeof tx.description === 'string' && tx.description.trim()
      ? ` — ${tx.description.trim()}`
      : '';

  return `[${type}] ${amount} for ${property}${category}${description}`;
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

// FIX (found in Phase 2 live testing, 🔴 — confirmed live): buildExpenseSubject
// below used to show ONLY category OR ONLY description, never both — and
// category always won when present. For a compound expense described in one
// message ("500k for ac repairs, toiletries and diesel at flat 2") the AI
// settles on a single word for `category` (one label can't capture three
// different items) — and the user's own itemized `description` was silently
// discarded from every confirmation/saved message, with zero indication the
// other items were even recorded, let alone saved. formatTransactionPreview
// above already combines category AND description correctly for the
// multi-item notice (`(category) — description`) — this brings the
// single-item confirmation/saved-message path in line with that same
// established pattern instead of dropping one of the two fields.
function buildExpenseSubject(draftView) {
  const property = draftView.propertyName || 'Unknown property';
  const category = draftView.category ? String(draftView.category).trim() : '';
  const description = draftView.description ? String(draftView.description).trim() : '';
  const descriptionAddsInfo = Boolean(description) && description.toLowerCase() !== category.toLowerCase();

  if (category && descriptionAddsInfo) {
    return `${category.toLowerCase()} at ${property} (${description})`;
  }

  if (category) {
    return `${category.toLowerCase()} at ${property}`;
  }

  if (description) {
    return `${description} at ${property}`;
  }

  return property;
}

export function buildTransactionSummary(draftView) {
  const amount = formatNaira(draftView.amount);
  const property = draftView.propertyName || 'Unknown property';
  const typeLabel = capitalize(draftView.type);

  if (draftView.type === 'income') {
    return `${typeLabel} ${amount} for ${property}`;
  }

  return `${typeLabel} ${amount} for ${buildExpenseSubject(draftView)}`;
}

// BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): this never
// mentioned the transaction date at all. That meant editing the date on a
// pending draft ("Edit the year to 2026", "Change the date to 1st January
// 2020") produced the EXACT SAME confirmation text as before the edit —
// the only place the corrected date ever appeared was in the final "Saved:
// ..." message, after the user had already committed. Live testing showed
// this made users think their date edit hadn't registered, so they'd repeat
// the same "change the date" command two or three times before finally
// sending YES. Appending the date whenever one is set closes that feedback
// gap without changing anything about the income/expense wording above.
function withDateSuffix(text, draftView) {
  const formatted = formatDisplayDate(draftView?.transactionDate);
  if (!formatted) return text;
  // Insert the date right before the final sentence ("Reply YES...") so it
  // reads naturally: "...for Orchid, dated 27 Jul 2026. Reply YES to save it."
  return text.replace(/\.\s*(Reply YES.*)$/, `, dated ${formatted}. $1`);
}

export function formatConfirmationMessage(draftView) {
  const amount = formatNaira(draftView.amount);
  const property = draftView.propertyName || 'Unknown property';

  if (draftView.type === 'income') {
    return withDateSuffix(`I've drafted an income entry of ${amount} for ${property}. Reply YES to save it.`, draftView);
  }

  const subject = buildExpenseSubject(draftView);
  return withDateSuffix(
    `I've drafted an expense of ${amount} for ${subject}. Reply YES to save it, or tell me what to change.`,
    draftView,
  );
}

export function formatCorrectionSuccessMessage(changeSummary) {
  const summary = changeSummary && String(changeSummary).trim() ? changeSummary : 'the draft';
  return `I've updated ${summary}. Reply YES to save it.`;
}

export function formatCancelledMessage() {
  return 'I\u2019ve discarded the pending entry. Nothing was saved.';
}

export function formatActiveDraftInquiryMessage(draftView) {
  const summary = buildTransactionSummary(draftView);

  return `You have a pending draft: ${summary}. Reply YES to save it or CANCEL to discard it.`;
}

export function formatClarificationMessage(question) {
  return String(question || 'Which detail should I use for this transaction?');
}

export function formatSavedMessage(draftView) {
  const summary = buildTransactionSummary(draftView);
  const date = formatDisplayDate(draftView.transactionDate);

  return `Saved: ${summary} on ${date}.`;
}

// Duplicate Detection (PROJECT_CONTEXT.md). Shown instead of the normal
// "Saved" message when a near-identical entry was confirmed recently —
// asks the exact question the spec calls for, plus enough detail (which
// existing entry it matched) for the user to tell at a glance whether
// this really is a second, separate transaction or an accidental resend.
export function formatDuplicateWarningMessage(draftView, matchedEntry) {
  const summary = buildTransactionSummary(draftView);
  const existingPreview = buildTransactionPreview(matchedEntry) || 'a similar transaction';

  return `This looks similar to a transaction you recently logged: ${existingPreview}. Save another one — ${summary}? Reply YES to save it anyway, or NO to cancel this one.`;
}

export function formatNoDraftMessage() {
  return '⚠️ There is no pending transaction to confirm. Send a new income or expense first.';
}

export function formatNoPendingDraftMessage() {
  return 'You don\u2019t have any pending entries right now. Send a transaction like *Paid 15,000 for repairs at Flat 2* whenever you\u2019re ready.';
}

export function toDraftView(pendingDraftDoc) {
  const entry = pendingDraftDoc?.draftEntry;

  if (!entry) return null;

  const propertyDoc = entry.property;
  let propertyName = 'Unknown property';

  if (entry.pendingNewPropertyName) {
    propertyName = entry.pendingNewPropertyName;
  } else if (propertyDoc && typeof propertyDoc === 'object' && propertyDoc.name) {
    propertyName = propertyDoc.name;
  } else if (propertyDoc && typeof propertyDoc === 'string' && propertyDoc !== 'null' && propertyDoc !== 'undefined') {
    propertyName = propertyDoc;
  }

  return {
    type: entry.type,
    propertyName,
    propertyId: propertyDoc?._id ? String(propertyDoc._id) : String(propertyDoc),
    amount: entry.amount,
    category: entry.category ?? null,
    description: entry.description || '',
    transactionDate: entry.transactionDate,
    sourceText: entry.sourceText,
  };
}

export function formatNoAwaitingClarificationMessage() {
  return [
    'There is nothing waiting for clarification.',
    '',
    'If you want to change the pending transaction, just tell me what to edit.',
    'Otherwise reply *YES* to save it or *cancel* to discard it.',
  ].join('\n');
}

export function formatCorrectionUnclearMessage() {
  return [
    'I\u2019m not sure what you want to change.',
    '',
    'For example you can say:',
    '• Change the amount to ₦20,000',
    '• Change the property to Flat 3',
    '• Change the date to yesterday',
    '',
    'Or reply *YES* to save the current draft.',
  ].join('\n');
}

export function formatDisplayDate(value) {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

// FIX (W, follow-through): when a message contains more than one
// transaction, we only ever draft the first one — by design. But the
// second item can't just vanish once the first is saved: a user who reads
// "I detected multiple transactions ... I can handle them one at a time"
// reasonably expects the bot to actually come back for the next one. This
// builds the lead-in line shown right after "Saved: ..." once the next
// queued item has been turned into its own new draft (see
// DraftManager.handleConfirmation).
export function formatQueuedTransactionLeadIn(tx, knownProperties = []) {
  return `I also caught a second transaction: ${formatTransactionPreview(tx, knownProperties)}.`;
}

// Phase 6.1 — "acknowledge a pending draft when the user switches context."
// Answering a QUERY or STATEMENT_REQUEST while a draft is pending was
// already safe (the draft never leaks into totals/statements), but the
// reply never mentioned that anything was still waiting. This is the short
// trailing note messageHandlerShared.js appends in that situation.
export function formatPendingDraftReminder() {
  return 'By the way, you still have an unconfirmed entry waiting \u2014 reply YES to save it or CANCEL to discard it.';
}

// Companion note for the one context switch that does NOT leave the draft
// untouched: a statement request purges any pending draft outright before
// generating the PDF (see StatementRequestService.js). Reusing
// formatPendingDraftReminder there would be actively wrong — it would tell
// the user an entry is "still waiting" moments after it was deleted. This
// gives an honest, equally short heads-up instead.
export function formatDraftClearedDuringContextSwitchNote() {
  return 'Note: your previous unsaved entry was cleared while preparing this \u2014 send it again if you\u2019d still like to log it.';
}

export default {
  formatAmount,
  resolvePropertyDisplayName,
  formatTransactionPreview,
  formatQueuedTransactionLeadIn,
  formatPendingDraftReminder,
  formatDraftClearedDuringContextSwitchNote,
  buildTransactionSummary,
  formatConfirmationMessage,
  formatCorrectionSuccessMessage,
  formatCorrectionUnclearMessage,
  formatCancelledMessage,
  formatActiveDraftInquiryMessage,
  formatClarificationMessage,
  formatNoAwaitingClarificationMessage,
  formatSavedMessage,
  formatDuplicateWarningMessage,
  formatNoDraftMessage,
  formatNoPendingDraftMessage,
  toDraftView,
  formatDisplayDate,
};