import * as DraftManager from '../../services/draft/DraftManager.js';
import * as DraftRepository from '../../services/draft/DraftRepository.js';
import * as DraftFormatter from '../../services/draft/DraftFormatter.js';
import * as QueryManager from '../../services/query/QueryManager.js';
import { AI_BUSY_FALLBACK_MESSAGE } from '../../ai/aiFallback.js';
import { handleStatementRequest } from '../../statement/StatementRequestService.js';
import { getKnownProperties } from '../../services/propertyLookup.service.js';
import { classifyMessage, hasTransactionSignal, looksLikeGenericQuestion, MONEY_AMOUNT_PATTERN } from '../../ai/MessageClassifier.js';
import { interpretQuery } from '../../services/query/QueryInterpreter.js';
import { parseTransaction } from '../../ai/parsing/TransactionParser.js';
import { buildCorrectionPatch } from '../../services/buildCorrectionPatch.js';
import { getUnknownReply } from './unKnownReply.js';
import { isGreetingMessage, findOrCreateUser } from './userService.js';
import { formatHelpCard, formatWelcomeMessage } from './welcomeFormatter.js';
import { saveChatMessage, getConversationContext, getRecentTransactions } from '../../services/ContextService.js';
import { createAIService } from '../../ai/createAIService.js';
import { buildInquirySystemPrompt } from '../../prompts/contextPromptBuilder.js';
import { SYSTEM_MANUAL } from '../../prompts/systemManual.js';
import env from '../../config/env.js';
import PendingStatement from '../../models/PendingStatement.js';
import PendingDeletion from '../../models/PendingDeletion.js';
import PendingFlagReview from '../../models/PendingFlagReview.js';
import PendingFlagClear from '../../models/PendingFlagClear.js';
import PendingEntryEdit from '../../models/PendingEntryEdit.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalize.js';
import { deleteLastTransactionService } from '../../services/deleteLastTransaction.service.js';
import { flagTransactionForReviewService } from '../../services/flagTransactionForReview.service.js';
import { clearFlaggedTransactionService } from '../../services/clearFlaggedTransaction.service.js';
import { editConfirmedTransactionService } from '../../services/editConfirmedTransaction.service.js';
import { card, row } from '../../utils/waFormat.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

// Matches a leading command phrase, optionally preceded by a short filler
// word ("please", "just", "ok(ay)"), and allows anything after it. Voice
// transcripts in particular are naturally wordier than typed commands
// ("Discard, discard any pending entry that I have." vs typed "cancel"),
// and typed replies aren't always a bare single word either ("Cancel any
// pending draft"). A strict whole-message-equals-one-word check misses
// both, and the message then falls through into unrelated routing (a
// pending-draft status check, or worse, the active clarification answer
// path) instead of doing what the user actually asked.
//
// Deliberately anchored at the START of the message rather than doing a
// loose "contains" match anywhere in the text — that keeps a real
// transaction description that happens to mention one of these words
// partway through ("paid to stop the leak") from being misread as a
// command, since it won't be the leading word.
function buildLeadingPhrasePattern(phrases) {
  const escaped = [...phrases]
    .sort((a, b) => b.length - a.length) // longest first so multi-word phrases aren't shadowed by a shorter overlapping alternative
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // FIX (2.5): swapped the trailing \b for a negative lookahead that only
  // requires the next character not be a letter/digit. \b fires strictly
  // at a transition between a word character and a non-word character —
  // for an emoji phrase like 👍 (itself a non-word character), there's no
  // such transition at end-of-string, so \b silently failed to match a
  // message that was ONLY "👍". The lookahead behaves identically for the
  // existing text phrases (still stops "yes" from matching inside
  // "yesterday") while also working correctly for emoji-only entries. The
  // added 'u' flag makes the regex treat astral-plane emoji as single code
  // points instead of splitting their surrogate pairs.
  return new RegExp(`^(?:please|just|ok(?:ay)?)?[,\\s]*(?:${escaped.join('|')})(?![a-zA-Z0-9])`, 'iu');
}

// FIX (§3d-i, 🔴 — confirmed live): "Drop this" wasn't recognized as a
// cancel command at all — it fell through the entire routing pipeline to
// the generic "I didn't understand that" fallback. Added "drop"/"drop
// this"/"drop it" as recognized cancel wording. "remove this"/"remove it"
// are added too (per the ideal-behavior note), but deliberately NOT bare
// "remove" — isDeleteLastTransactionRequest further down the pipeline
// already owns "remove the last transaction" / "remove last entry" as a
// DIFFERENT intent (deleting an already-committed transaction, not
// discarding an in-progress draft), and isCancelCommand is checked first
// in the pipeline. A bare "remove" here would shadow that entirely and
// misroute "Remove the last transaction" into a draft-cancel instead.
// Scoping to the specific "remove this"/"remove it" phrases avoids that
// collision while still covering the natural "drop this" style wording.
const CANCEL_PHRASES = ['cancel', 'discard', 'abort', 'never mind', 'nevermind', 'forget it', 'stop', 'drop', 'remove this', 'remove it'];
// FIX (2.5): added the positive-confirmation phrasing that was still
// missing after the CANCEL_PHRASES-side fix — "proceed"/"do it"/"confirmed"
// as words, plus the 👍/👌 emoji replies real users actually send instead
// of typing "yes". Purely a phrase-list expansion (see
// buildLeadingPhrasePattern above for the matching-boundary fix that makes
// the emoji entries actually work) — the deterministic confirm/cancel
// state machine itself is untouched.
const CONFIRMATION_PHRASES = ['yes', 'y', 'ok', 'okay', 'confirm', 'confirmed', 'correct', 'sure', 'yep', 'yeah', 'go ahead', 'please do', 'proceed', 'do it', '👍', '👌'];
const NEGATIVE_CONFIRMATION_PHRASES = ['no', 'n', ...CANCEL_PHRASES];

const CANCEL_COMMAND_PATTERN = buildLeadingPhrasePattern(CANCEL_PHRASES);
const CONFIRMATION_WORDS = buildLeadingPhrasePattern(CONFIRMATION_PHRASES);
const NEGATIVE_CONFIRMATION_WORDS = buildLeadingPhrasePattern(NEGATIVE_CONFIRMATION_PHRASES);

export function isCancelCommand(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return CANCEL_COMMAND_PATTERN.test(normalized);
}

export function isConfirmationWord(text) {
  return typeof text === 'string' && CONFIRMATION_WORDS.test(text.trim());
}

export function isNegativeConfirmationWord(text) {
  return typeof text === 'string' && NEGATIVE_CONFIRMATION_WORDS.test(text.trim());
}

function isDraftExpired(draft) {
  if (!draft?.createdAt) {
    return false;
  }

  return Date.now() - new Date(draft.createdAt).getTime() > DRAFT_TTL_MS;
}

async function getActiveDraft(fromNumber) {
  const cleanNumber = normalizePhoneNumber(fromNumber);
  const draft = await DraftRepository.findPendingDraftByFromNumber(cleanNumber);
  if (!draft) {
    return null;
  }

  if (!isDraftExpired(draft)) {
    return draft;
  }

  await DraftRepository.deletePendingDraft(cleanNumber);
  return null;
}

function getLatestAssistantMessage(chatHistory = []) {
  return [...chatHistory]
    .reverse()
    .find((message) => message?.role === 'assistant' && typeof message?.content === 'string');
}

// Matches a leading greeting/salutation so a message like "Hi, paid 15k for
// repairs" or "Good morning! Received 50k rent" is still recognized as a
// transaction. Deliberately requires content AFTER the greeting (a bare
// "Hi" must fall through to the normal greeting handler, not this path).
const GREETING_PREFIX_PATTERN = /^(?:hi+|hello+|hey+|good\s+(?:morning|afternoon|evening)|greetings)\b[\s,!.:-]*/i;

/**
 * Splits a leading greeting/salutation off the front of a message, if
 * present. Used so a combined greeting+transaction message ("Hi, paid 15k
 * for repairs") can be recognized as a transaction while still letting the
 * reply acknowledge the greeting.
 *
 * @param {string} text
 * @returns {{ hadGreeting: boolean, body: string }}
 */
export function splitLeadingGreeting(text) {
  if (typeof text !== 'string') {
    return { hadGreeting: false, body: text };
  }

  const match = text.match(GREETING_PREFIX_PATTERN);
  if (!match) {
    return { hadGreeting: false, body: text };
  }

  const body = text.slice(match[0].length).trim();
  if (!body) {
    // The whole message was just a greeting — leave it for the dedicated
    // greeting handler rather than pretending there's transaction content.
    return { hadGreeting: false, body: text };
  }

  return { hadGreeting: true, body };
}

// FIX (2.3): broadened verb vocabulary so more real (typed and
// voice-transcribed) phrasings reach the AI parser via the fast path
// without needing an exact keyword hit — e.g. "Bought diesel for 15k",
// "Sold old generator for 60k", "Withdrew 20k for site expenses", "Gave
// the plumber 10k". Deliberately does NOT touch CONFIRMATION_WORDS /
// CANCEL_COMMAND_PATTERN above — only this "is this clearly a fresh
// transaction" heuristic changes. Extracted to one constant so
// startVerb / verbThenValue / currencyThenValueThenVerb can't drift apart
// from each other, same reasoning as sharing hasTransactionSignal between
// this file and MessageClassifier.js (see isCorrectionRequest further
// down). Kept as its own local list rather than importing
// MessageClassifier.js's TRANSACTION_VERB_PATTERN directly — that pattern
// is intentionally looser (bare word-boundary match, used to SUPPRESS a
// heuristic) while this one intentionally anchors the verb at the start of
// the message, a stricter requirement for a different job (triggering a
// fast-path parse). The vocabulary is kept aligned by hand instead.
const TRANSACTION_VERBS =
  'receiv(?:ed|ing|e)?|reciev(?:ed|d)?|reciv(?:ed|ing|e)?|receveid|got(?:ten)?|made|collected|spe?nt|spet|pa(?:id|yed)|transfer(?:red|ing|s)?|credit(?:ed)?|debit(?:ed)?|bought|purchased|sold|deposit(?:ed|ing)?|withdr(?:ew|awn|aw(?:ing)?)|gave|refund(?:ed)?|earn(?:ed|ing)?|settl(?:ed|ing)?|clear(?:ed|ing)?|charged|billed|invoiced';

const EXPLICIT_TXN_START_VERB = new RegExp(`^(${TRANSACTION_VERBS}|income|expense)\\b`, 'i');
const EXPLICIT_TXN_VERB_THEN_VALUE = new RegExp(
  `(${TRANSACTION_VERBS})\\s*(?:₦|naira|ngn)?\\s*[\\d.,]+(?:\\s*(?:million|m|billion|b|thousand|k|naira|ngn))?\\b`,
  'i',
);
const EXPLICIT_TXN_CURRENCY_THEN_VERB = new RegExp(
  `^(?:₦|naira|ngn)?\\s*[\\d.,]+(?:\\s*(?:million|m|billion|b|thousand|k|naira|ngn))?\\s+(?:income|expense|${TRANSACTION_VERBS})\\b`,
  'i',
);

export function isExplicitTransaction(text) {
  if (typeof text !== 'string') return false;
  const { body } = splitLeadingGreeting(text);
  const clean = body.toLowerCase().trim();

  if (
    EXPLICIT_TXN_START_VERB.test(clean) &&
    (EXPLICIT_TXN_VERB_THEN_VALUE.test(clean) || EXPLICIT_TXN_CURRENCY_THEN_VERB.test(clean))
  ) {
    return true;
  }

  return isStructuredTransactionEntry(body);
}

// BUG FIX (live, confirmed — real data-loss risk): a transaction typed in
// "label: value" form with no leading verb at all — e.g.
// "Gas refill: 12,200\nProperty: A7 downstairs\nDate: 24th Aug 2026" —
// matched none of the verb-led patterns above, so it fell all the way
// through to classifyMessage's deterministic layer. That layer has a bare
// /\bproperty\b/ rule under GENERAL_INQUIRY (see MessageClassifier.js) —
// meant for genuine questions like "how do I add a property?" — which
// fires on ANY message containing the word "property" at all, including
// one that's plainly listing transaction fields. GENERAL_INQUIRY then
// handed the raw text to a free-form AI chat reply, which — with nothing
// stopping it — HALLUCINATED a fake draft card that visually mimics
// DraftFormatter's real output ("I have your expense draft ready...Reply
// yes to confirm") despite no PendingDraft ever being created. The user
// believes they logged a transaction; nothing was ever saved.
//
// The fix here closes the root cause: recognize this label-style format
// up front, the same way a verb-led message already skips classification
// entirely and goes straight to the real parser/draft pipeline. See
// contextPromptBuilder.js for the second, independent layer — GENERAL_INQUIRY
// itself is now also forbidden from ever producing draft-looking text, so
// this exact failure mode can't recur even if some other phrasing still
// slips past this detector.
//
// Deliberately requires BOTH signals together, not just the bare word
// "property": at least one generic "label: value" line (broad — could be
// any label the user chooses, like "Gas refill: 12,200"), AND a
// recognizable bookkeeping field label (Property/Category/Date/Amount)
// with its own colon. That combination is specific enough to essentially
// never appear in a genuine question, while still catching real users
// typing transactions as a small structured note instead of a sentence.
const COLON_VALUE_LINE_PATTERN = /^[^\n:]{2,40}:\s*\S.*$/m;
const BOOKKEEPING_FIELD_LABEL_PATTERN = /\b(property|category|date|amount)\s*:/i;

export function isStructuredTransactionEntry(text) {
  if (typeof text !== 'string') return false;
  if (!MONEY_AMOUNT_PATTERN.test(text)) return false;
  return COLON_VALUE_LINE_PATTERN.test(text) && BOOKKEEPING_FIELD_LABEL_PATTERN.test(text);
}

// FIX (W, related): previews now resolve to human-readable property names
// instead of raw database IDs — see DraftFormatter.formatTransactionPreview
// (moved there so DraftManager.js's queue-continuation message can reuse
// the exact same formatting instead of drifting out of sync with this one).

function isDeleteLastTransactionRequest(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const clean = text.trim().toLowerCase();
  return /\b(delete|remove|undo)\b/.test(clean) && /\b(last|most recent)\b/.test(clean) && /\b(transaction|entry|one)\b/.test(clean);
}

// Task 3.2 — companion fast-path to isDeleteLastTransactionRequest above,
// for the case that pattern deliberately does NOT cover: correcting a
// transaction that's already been confirmed (and isn't necessarily the
// last one at all — a mistake noticed days later usually isn't). Rather
// than guess at an in-place edit with no way to safely identify which
// older record the user means, this routes to flagTransactionForReview,
// which searches by whatever amount/property the user names and only ever
// acts after an explicit YES. Mirrors isDeleteLastTransactionRequest's
// shape exactly, same narrow-keyword-pair reasoning (see
// MessageClassifier.js's matching deterministic rule).
function isFlagTransactionRequest(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const clean = text.trim().toLowerCase();
  // Follow-up fix: "review"/"double-check"/etc. was required alongside
  // "flag"/"mark", but real usage is often just "Flag my transaction with
  // expense of 50k at orchid" — no "review" wording at all. "flag" alone
  // as a verb is rare enough in ordinary bookkeeping text to be safe as a
  // standalone trigger; "mark" alone is not (e.g. "mark this paid" means
  // something else), so it still needs the review-ish companion word.
  if (/\bflag\b/.test(clean)) {
    return true;
  }
  return (
    /\bmark\b/.test(clean) &&
    /\b(review|recheck|re-check|double[- ]check|manual review|check (?:this|it) again|look (?:at )?(?:this|it) again)\b/.test(clean)
  );
}

// Task 3.3 — "the flag is resolved" companion to isFlagTransactionRequest.
// Checked BEFORE isFlagTransactionRequest wherever both are consulted:
// "mark as reviewed" would otherwise never distinctly match (\breview\b
// doesn't match "reviewed" — see below — so there's no real collision, but
// keeping clear-flag first keeps the two firmly separated as the wording
// evolves).
function isClearFlagRequest(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const clean = text.trim().toLowerCase();
  return /\bunflag\b/.test(clean) || (/\b(clear|remove)\b/.test(clean) && /\bflag\b/.test(clean)) || /\breviewed\b/.test(clean);
}

// Task 3.3 — locates an already-confirmed transaction to correct. Gated to
// only fire when there's no active draft (see resolvePipelineResult):
// "edit"/"correct" while a draft is pending should always mean the draft —
// that's the existing, well-tested behaviour — never this newer, narrower
// path for older/already-confirmed records.
//
// Bug fix (manual WhatsApp testing): "Edit the 10k for cleaning at orchid"
// (no active draft at the time) never matched this — it says "edit" but
// never says the word "transaction," "entry," "payment," or "record" — so
// it fell all the way through to CORRECTION intent's no-active-draft
// fallback instead, which replied "There is no pending transaction to
// confirm," a confusing message given the user never asked to confirm
// anything. Broadened so a real amount mentioned alongside an edit verb is
// treated as an equally valid signal the user is trying to reference a
// specific past transaction — still tightly gated (edit-type verb
// required either way, and this whole function only ever runs when no
// draft is active), so this doesn't risk misfiring into the
// active-draft-correction territory covered by isCorrectionRequest above.
export function isEditConfirmedTransactionRequest(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const clean = text.trim().toLowerCase();
  const hasEditVerb = /\b(edit|fix|correct)\b/.test(clean);
  return hasEditVerb && (/\b(transaction|entry|payment|record)\b/.test(clean) || MONEY_AMOUNT_PATTERN.test(clean));
}

// FIX (W): previously this only ever said "Note: Only the first item is
// drafted below; I can log the rest one at a time after this." — which
// left the user to infer, from the word "Note", that anything was being
// asked of them at all. Now it explicitly states what was detected and
// asks a direct question, so the user knows a reply is expected instead of
// silently seeing a single drafted item show up when they described two.
export function buildMultiItemNotice(parseResult, { awaitingClarification = false, knownProperties = [] } = {}) {
  const previewPool = Array.isArray(parseResult?.parsedTransactions) && parseResult.parsedTransactions.length > 1
    ? parseResult.parsedTransactions
    : [];

  if (previewPool.length <= 1 && parseResult?.classification !== 'MULTIPLE') {
    return '';
  }

  const lines = previewPool.map((tx) => `• ${DraftFormatter.formatTransactionPreview(tx, knownProperties)}`);
  if (lines.length === 0) {
    return '';
  }

  const followUp = awaitingClarification
    ? "I can handle them one at a time — let's start with the first one."
    : 'I can handle them one at a time. Shall I log the first one now?';

  return `🧾 *Multiple Transactions Detected*\n\n${lines.join('\n')}\n\n_${followUp}_\n\n`;
}

function withGreetingPrefix(replyText, hadGreeting) {
  if (!hadGreeting || typeof replyText !== 'string' || !replyText) {
    return replyText;
  }
  return `👋 Hi!\n\n${replyText}`;
}

// Shared by both correction-mismatch call sites below (draft-correction
// path and the confirmed-transaction-edit path) so the "did you mean a
// new entry or an update to this one" prompt reads the same everywhere.
function buildCorrectionMismatchReply(correctionParseResult, currentSummary) {
  return card(
    '🤔',
    'Different Transaction?',
    [
      row('New text', correctionParseResult.mismatchNote || 'looks unrelated to your current draft'),
      row('Current draft', currentSummary),
    ],
    'Did you mean to start a new entry, or update this one? Reply with the correction again more specifically, or send the new transaction on its own.',
  );
}

async function handleParsedLogEntry({ parsed, fromNumber, senderId, hadGreeting = false, knownProperties = [] }) {
  if (parsed.aiUnavailable) {
    return {
      replyText: withGreetingPrefix(AI_BUSY_FALLBACK_MESSAGE, hadGreeting),
      classification: parsed.classification,
    };
  }

  const classification = parsed.classification || 'AMBIGUOUS';
  const cleanFrom = normalizePhoneNumber(fromNumber);
  const cleanSender = normalizePhoneNumber(senderId);

  const draftManagerResult = await DraftManager.handleLogEntry({
    fromNumber: cleanFrom,
    senderId: cleanSender,
    parseResult: parsed,
  });

  // FIX (W): the multi-item notice used to only appear when the first item
  // was fully resolved and ready for confirmation. If the first item itself
  // needed clarification (e.g. "Received 100k rent and paid for repairs" —
  // amount missing on the second-turned-first item), the user got a bare
  // clarification question with zero indication that a second transaction
  // had even been seen. Now both outcomes carry the notice.
  if (draftManagerResult?.state === 'PENDING_CONFIRMATION' || draftManagerResult?.state === 'AWAITING_CLARIFICATION') {
    const notice = buildMultiItemNotice(parsed, {
      awaitingClarification: draftManagerResult.state === 'AWAITING_CLARIFICATION',
      knownProperties,
    });
    const baseText = typeof draftManagerResult.replyText === 'string' ? draftManagerResult.replyText : '';
    return {
      ...draftManagerResult,
      replyText: withGreetingPrefix(`${notice}${baseText}`, hadGreeting),
      classification,
    };
  }

  return {
    ...(draftManagerResult || {}),
    replyText: withGreetingPrefix(draftManagerResult?.replyText, hadGreeting),
    classification,
  };
}

// Phase 6.1 — "acknowledge a pending draft when the user switches context."
// Answering a QUERY or STATEMENT_REQUEST while a draft is pending was
// already safe (confirmed: drafts never leak into totals or statements —
// QueryRepository.js, StatementRepository.js), but the reply never
// mentioned it. This appends a short trailing note to the result of those
// two branches — but only ever states something that's actually still
// true by the time the reply goes out:
//   - QUERY never touches PendingDraft at all, so if a draft existed
//     before the query ran, it's still there afterwards — the normal
//     "you still have an unconfirmed entry" reminder applies.
//   - STATEMENT_REQUEST calls DraftRepository.deletePendingDraft as part
//     of its own flow (see StatementRequestService.js), so by the time
//     this runs the draft may already be gone. Re-checking after the call
//     (rather than trusting the pre-call snapshot) keeps the note honest
//     either way, and is resilient if that purge behavior ever changes.
async function withDraftContinuityNote(result, { hadActiveDraft, cleanFrom }) {
  if (!hadActiveDraft || !result || typeof result.replyText !== 'string' || !result.replyText) {
    return result;
  }

  const stillPending = await DraftRepository.findPendingDraftByFromNumber(cleanFrom).catch(() => null);
  const note = stillPending
    ? DraftFormatter.formatPendingDraftReminder()
    : DraftFormatter.formatDraftClearedDuringContextSwitchNote();

  return { ...result, replyText: `${result.replyText}\n\n${note}` };
}

export async function routeByIntent({ intent, text, fromNumber, knownProperties, senderId, allowFastPath = true, context = {}, activeDraft = null }) {
  const cleanFrom = normalizePhoneNumber(fromNumber);
  const cleanSender = normalizePhoneNumber(senderId);

  console.log('[DEBUG] routeByIntent intent =', intent, 'text =', text, 'allowFastPath =', allowFastPath);

  if (allowFastPath && isExplicitTransaction(text)) {
    console.log('[DEBUG] Fast-path triggered in routeByIntent: Overriding intent to LOG_ENTRY');
    const { hadGreeting } = splitLeadingGreeting(text);
    const parsed = await parseTransaction(text, { knownProperties, senderId: cleanSender });
    return handleParsedLogEntry({ parsed, fromNumber: cleanFrom, senderId: cleanSender, hadGreeting, knownProperties });
  }

  const activeStatement = await PendingStatement.findOne({ fromNumber: cleanFrom });
  if (activeStatement && (intent === 'STATEMENT_REQUEST' || intent === 'UNKNOWN' || intent === 'AFFIRMATION')) {
    console.log('[DEBUG] Intercepted message for active PendingStatement session');
    return handleStatementRequest({
      text,
      phoneNumber: cleanFrom,
      knownProperties,
      senderId: cleanSender,
    });
  }

  if (intent === 'LOG_ENTRY') {
    const parsed = await parseTransaction(text, { knownProperties, senderId: cleanSender });
    return handleParsedLogEntry({ parsed, fromNumber: cleanFrom, senderId: cleanSender, knownProperties });
  }

  if (intent === 'CONFIRMATION') {
    // PERF FIX: these four lookups are mutually exclusive (a sender can
    // have at most one pending action of these types at once) and none
    // depends on another's result, but they were checked one at a time —
    // in the common case where none of them match (by far the most common
    // outcome, since most "yes" replies are just confirming a normal
    // draft), that meant paying for four sequential DB round trips before
    // ever reaching the actual DraftManager confirmation below. Running
    // them concurrently turns that into the cost of the single slowest
    // lookup instead of the sum of all four — a real, network-independent
    // latency win on one of the most common message types in the app.
    const [pendingDeletion, pendingFlag, pendingClear, pendingEdit] = await Promise.all([
      PendingDeletion.findOne({ fromNumber: cleanFrom }).lean(),
      PendingFlagReview.findOne({ fromNumber: cleanFrom }).lean(),
      PendingFlagClear.findOne({ fromNumber: cleanFrom }).lean(),
      PendingEntryEdit.findOne({ fromNumber: cleanFrom }).lean(),
    ]);

    // Precedence preserved exactly as before (deletion > flag > clear >
    // edit > plain draft) — only the fetching became concurrent, not the
    // decision logic.
    if (pendingDeletion) {
      return deleteLastTransactionService.handleConfirmation({ fromNumber: cleanFrom, senderId: cleanSender });
    }
    if (pendingFlag) {
      return flagTransactionForReviewService.handleConfirmation({ fromNumber: cleanFrom, senderId: cleanSender });
    }
    if (pendingClear) {
      return clearFlaggedTransactionService.handleConfirmation({ fromNumber: cleanFrom, senderId: cleanSender });
    }
    if (pendingEdit && pendingEdit.stage === 'AWAITING_CONFIRMATION') {
      return editConfirmedTransactionService.handleConfirmation({ fromNumber: cleanFrom, senderId: cleanSender });
    }
    return DraftManager.handleConfirmation({ fromNumber: cleanFrom, senderId: cleanSender, knownProperties });
  }

  if (intent === 'DELETE_LAST_TRANSACTION') {
    return deleteLastTransactionService.handleDeleteRequest({ fromNumber: cleanFrom, senderId: cleanSender });
  }

  if (intent === 'FLAG_TRANSACTION') {
    return flagTransactionForReviewService.handleFlagRequest({ text, fromNumber: cleanFrom, senderId: cleanSender, knownProperties });
  }

  if (intent === 'CLEAR_FLAG') {
    return clearFlaggedTransactionService.handleClearRequest({ text, fromNumber: cleanFrom, senderId: cleanSender, knownProperties });
  }

  if (intent === 'EDIT_TRANSACTION') {
    return editConfirmedTransactionService.handleEditRequest({ text, fromNumber: cleanFrom, senderId: cleanSender, knownProperties });
  }

  if (intent === 'CORRECTION') {
    // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): a correction
    // phrased with "change"/"update"/etc. (not "edit"/"fix"/"correct") and
    // with no active draft used to sail straight into
    // DraftManager.handleCorrection, which — having nothing to correct —
    // replied with "There is no pending transaction to confirm. Send a new
    // income or expense first." That's the exact confusing message Section
    // 10g already flagged and fixed for the "edit"/"fix"/"correct" wording
    // via isEditConfirmedTransactionRequest — but that fix only covers
    // messages already intercepted before classification, so a message
    // that reaches here as CORRECTION intent via a *different* verb
    // ("change", "update", "switch", "move"...) with no draft slipped
    // through the same gap under a different name. Rather than keep
    // patching one verb at a time, any CORRECTION with no active draft now
    // goes to the exact same "find and edit an already-confirmed
    // transaction" flow — it will locate a match, ask which one if there
    // are several, or give a clear "I couldn't find a match" / "please
    // include an amount or property" answer instead of the old message.
    if (!activeDraft) {
      const result = await editConfirmedTransactionService.handleEditRequest({
        text,
        fromNumber: cleanFrom,
        senderId: cleanSender,
        knownProperties,
      });
      return { ...result, classification: 'EDIT_TRANSACTION' };
    }

    const { patch, parseResult: correctionParseResult } = await buildCorrectionPatch(text, {
      knownProperties,
      // Fix (follow-up to Phase 6.3): lets a partial edit like "edit the
      // year to 2026" combine with the draft's existing date instead of
      // the AI guessing the rest — see buildCorrectionPatch.js.
      currentTransactionDate: activeDraft?.draftEntry?.transactionDate,
      // Fix (manual WhatsApp testing): lets the AI recognize when the
      // request actually describes a DIFFERENT transaction than the
      // active draft, instead of blindly applying whatever single field
      // it could extract — see buildCorrectionPatch.js.
      currentDraftSummary: activeDraft
        ? DraftFormatter.formatTransactionPreview(activeDraft.draftEntry, knownProperties)
        : undefined,
    });

    if (correctionParseResult?.possibleMismatch) {
      const currentSummary = activeDraft
        ? DraftFormatter.formatTransactionPreview(activeDraft.draftEntry, knownProperties)
        : 'your current draft';
      return {
        replyText: buildCorrectionMismatchReply(correctionParseResult, currentSummary),
      };
    }
    return DraftManager.handleCorrection({
      fromNumber: cleanFrom,
      senderId: cleanSender,
      patch,
      knownProperties,
      referenceDate: new Date(),
    });
  }

  if (intent === 'QUERY') {
    const result = await QueryManager.handleQuery({
      text,
      knownProperties,
      senderId: cleanSender,
    });
    return withDraftContinuityNote(result, { hadActiveDraft: Boolean(activeDraft), cleanFrom });
  }

  if (intent === 'STATEMENT_REQUEST') {
    const result = await handleStatementRequest({
      text,
      phoneNumber: cleanFrom,
      knownProperties,
      senderId: cleanSender,
    });
    return withDraftContinuityNote(result, { hadActiveDraft: Boolean(activeDraft), cleanFrom });
  }

  if (intent === 'GREETING') {
    return { replyText: formatHelpCard({ isGreeting: true }), classification: 'GREETING' };
  }

  if (intent === 'GENERAL_INQUIRY') {
    try {
      // FIX (Phase 1.5, 🔴 — confirmed live): classifyMessage already
      // fetches chatHistory (always) and recentTransactions (whenever the
      // AI classifier path is reached — see MessageClassifier.js) just
      // moments before this branch runs. This used to re-fetch both from
      // scratch instead of reusing them — two extra DB round-trips on
      // every general-inquiry reply for data already sitting in memory.
      // Reuse what was passed through; only fetch if genuinely missing
      // (e.g. intent resolved some other way, or a future caller invokes
      // routeByIntent directly without the classifier context).
      const chatHistory = context.chatHistory ?? (await getConversationContext(cleanSender));
      const recentTransactions = context.recentTransactions ?? (await getRecentTransactions(cleanSender));
      const aiService = createAIService();
      const systemPrompt = buildInquirySystemPrompt({ chatHistory, recentTransactions, referenceDate: new Date() });
      const result = await aiService.completeJson({
        system: systemPrompt,
        user: text,
        schemaHint: '{ "reply": "string" }',
      });
      return { replyText: result.reply || "🤔 I'm not sure how to help with that — please try rephrasing!" };
    } catch (err) {
      console.error('[DEBUG] Error handling general inquiry, falling back to SOP:', err);
      const fallbackReply = `📖 *Quick Guide*\n\n${SYSTEM_MANUAL.split('---')[1] || SYSTEM_MANUAL}`;
      return { replyText: fallbackReply };
    }
  }

  if (intent === 'AFFIRMATION') {
    // FIX (Phase 1.5, 🔴 — confirmed live, same duplicate-fetch pattern as
    // GENERAL_INQUIRY above): classifyMessage already fetched chatHistory
    // to make this exact AFFIRMATION determination in the first place —
    // re-fetching it here was a second identical DB round-trip for data
    // already available from the call that just happened.
    const chatHistory = context.chatHistory ?? (await getConversationContext(cleanSender));
    const lastAssistantMessage = getLatestAssistantMessage(chatHistory);
    const lastAssistantText = lastAssistantMessage?.content || '';

    if (/(would you like|do you want|try logging|log one now|log a transaction)/i.test(lastAssistantText)) {
      return {
        replyText: `👍 Great! Please share the details for *${env.businessName}* — e.g. *Received 150,000 rent for Flat 2* or *Spent 15,000 on plumbing*.`,
      };
    }

    if (/(run a report|generate a report|generate a statement|monthly statement|statement now)/i.test(lastAssistantText)) {
      return {
        replyText: '📄 Sure — please send the request like *Monthly statement for Flat 2* or *Monthly statement for Green Villa for July 2026*.',
      };
    }

    return {
      replyText: `👍 Great. Please send the exact details you want me to work with for *${env.businessName}*, and I will guide you from there.`,
    };
  }

  if (intent === 'UNKNOWN') {
    // FIX (2.1): UNKNOWN used to always reply with the same static generic
    // card no matter what the user typed. Mirrors the
    // GENERAL_INQUIRY branch above — reuse context.chatHistory/
    // recentTransactions from classifyMessage's earlier fetch when present,
    // only fetching if genuinely missing, for the same reason documented
    // there (avoid a duplicate DB round-trip for data already in memory).
    const chatHistory = context.chatHistory ?? (await getConversationContext(cleanSender));
    const recentTransactions = context.recentTransactions ?? (await getRecentTransactions(cleanSender));
    const replyText = await getUnknownReply(text, { chatHistory, recentTransactions });
    return { replyText };
  }

  return null;
}

// FIX (§1, 🔴): this used to be an early return inside processMessageContent
// — `if (isNewUser && !isExplicitTransaction(content)) { return welcome }` —
// which unconditionally discarded the user's actual message the moment it
// didn't match the strict isExplicitTransaction regex. A brand-new user's
// very first message being anything other than a textbook "Verb Amount..."
// string (a query, a pronoun-led transaction, a voice transcript) vanished
// with zero trace: never classified, never parsed, never logged.
//
// The fix: isNewUser no longer short-circuits anything. Every message —
// new user or not — now runs through the full pipeline below, so real
// content always gets classified/routed/drafted. The "welcome a new user"
// behavior is preserved by decorating the FINAL reply (see
// decorateForNewUser, called once from processMessageContent) with a short
// preamble, rather than replacing the reply outright. A bare greeting from
// a new user still gets the full formatWelcomeMessage() via the
// isGreetingMessage branch below — decorateForNewUser skips that case
// (classification === 'GREETING') so it isn't doubled up.
function decorateForNewUser(result, isNewUser) {
  if (!isNewUser || !result || typeof result.replyText !== 'string' || !result.replyText) {
    return result;
  }
  if (result.classification === 'GREETING') {
    return result;
  }
  return {
    ...result,
    replyText: `${formatWelcomeMessage({ short: true })}\n\n${result.replyText}`,
  };
}

// BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): while a
// PendingEntryEdit was sat AWAITING_CONFIRMATION ("Reply YES to save that
// change, or NO / CANCEL to stop"), ANY other message — including a
// completely unrelated query like "Send me my last 3 transactions" — got
// the exact same canned re-prompt, as if the question had never been
// asked. A pending transaction draft already handles this correctly (see
// withDraftContinuityNote above: queries/statements are answered, with a
// short reminder that the draft is still waiting) — a pending edit
// confirmation never got the same treatment. This gives it one: try to
// answer the message as a genuine query or statement request first, and
// only fall back to the plain re-prompt if it isn't one.
async function tryAnswerQueryOrStatementWhilePending({ content, cleanFromNumber, senderId, knownProperties }) {
  let classification;
  try {
    classification = await classifyMessage(content, { senderId });
  } catch (e) {
    console.log('[DEBUG] tryAnswerQueryOrStatementWhilePending classify failed:', e);
    return null;
  }

  if (classification.aiUnavailable) return null;

  let intent = classification.intent || 'UNKNOWN';
  if (intent === 'UNKNOWN') {
    try {
      const queryResult = await interpretQuery(content, { knownProperties, senderId });
      if (queryResult.queryType !== 'UNKNOWN') intent = 'QUERY';
    } catch (e) {
      console.log('[DEBUG] tryAnswerQueryOrStatementWhilePending interpretQuery failed:', e);
    }
  }

  if (intent === 'QUERY') {
    const result = await QueryManager.handleQuery({ text: content, knownProperties, senderId });
    return { ...result, classification: 'QUERY' };
  }

  if (intent === 'STATEMENT_REQUEST') {
    const result = await handleStatementRequest({ text: content, phoneNumber: cleanFromNumber, knownProperties, senderId });
    return { ...result, classification: 'STATEMENT_REQUEST' };
  }

  return null;
}

// Contains the actual routing pipeline (steps 4-15 described in the audit).
// Deliberately does NOT call saveAssistantMessage itself — processMessageContent
// does that exactly once, after decorating the reply for new users, so the
// chat history always matches exactly what the user received.
// Exported (in addition to processMessageContent) so tests can drive the
// routing pipeline directly with a mocked DB layer, without needing to
// stand up findOrCreateUser/saveChatMessage/getActiveDraft as well — see
// pendingEditInterruption.test.js.
export async function resolvePipelineResult({ content, cleanFromNumber, senderId, knownProperties, activeDraft }) {
  // PERF FIX: these four "is there a pending X for this sender" lookups
  // used to be fired one at a time, spread out across this function (some
  // immediately, some only reached after several earlier checks had
  // already fallen through). None of them depends on another's result or
  // on anything computed in between — they're all independent reads keyed
  // on the same cleanFromNumber. Firing them together up front means the
  // overwhelming common case (no pending state at all, just a normal
  // message) pays for one round trip instead of up to four in sequence.
  // The one behavior change is intentional and harmless: when pendingEdit
  // IS active, the other three now get queried too instead of being
  // skipped — three extra cheap indexed reads running concurrently with
  // (not after) the pendingEdit read itself, so that path isn't any
  // slower. The decision logic and its precedence below are byte-for-byte
  // unchanged; only how the data got fetched changed.
  const [pendingEdit, pendingFlag, pendingClear, pendingDeletion] = await Promise.all([
    PendingEntryEdit.findOne({ fromNumber: cleanFromNumber }).lean(),
    PendingFlagReview.findOne({ fromNumber: cleanFromNumber }).lean(),
    PendingFlagClear.findOne({ fromNumber: cleanFromNumber }).lean(),
    PendingDeletion.findOne({ fromNumber: cleanFromNumber }).lean(),
  ]);

  // Task 3.3 — an in-progress "edit an already-confirmed transaction"
  // conversation takes priority over everything else in this function,
  // same reasoning as the activeDraft-scoped handling further below: the
  // user's next message is almost certainly a direct answer to what THIS
  // flow just asked (a change description, or YES/NO) — not a fresh
  // classification target, a greeting, or the generic cancel path. Checked
  // first so "cancel" mid-edit reliably cancels the EDIT, rather than
  // falling into the generic isCancelCommand branch below (which only
  // knows about drafts).
  if (pendingEdit) {
    if (isCancelCommand(content) || NEGATIVE_CONFIRMATION_WORDS.test(content.trim())) {
      const result = await editConfirmedTransactionService.handleCancellation({ fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'CANCEL' };
    }

    if (pendingEdit.stage === 'AWAITING_CONFIRMATION') {
      if (CONFIRMATION_WORDS.test(content.trim())) {
        const result = await editConfirmedTransactionService.handleConfirmation({ fromNumber: cleanFromNumber, senderId });
        return { ...result, replyText: result.replyText, classification: 'EDIT_TRANSACTION' };
      }

      const answeredElsewhere = await tryAnswerQueryOrStatementWhilePending({
        content,
        cleanFromNumber,
        senderId,
        knownProperties,
      });
      if (answeredElsewhere?.replyText) {
        return {
          ...answeredElsewhere,
          replyText: `${answeredElsewhere.replyText}\n\n_💡 By the way, you still have a pending edit waiting — reply YES to save the change, or NO / CANCEL to stop._`,
        };
      }

      return {
        replyText: '✏️ *Pending Edit*\n\nReply YES to save that change, or NO / CANCEL to stop.',
        classification: 'EDIT_TRANSACTION',
      };
    }

    if (pendingEdit.stage === 'AWAITING_SELECTION') {
      const result = await editConfirmedTransactionService.handleDisambiguation({ text: content, fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'EDIT_TRANSACTION' };
    }

    // stage === 'AWAITING_CHANGES': anything that isn't cancel/negative is
    // treated as the description of what to change.
    const result = await editConfirmedTransactionService.handleChangeRequest({
      text: content,
      fromNumber: cleanFromNumber,
      senderId,
      knownProperties,
    });
    return { ...result, replyText: result.replyText, classification: 'EDIT_TRANSACTION' };
  }

  // Task 3.3 — pending "flag for review" and "clear this flag" states,
  // same top-of-function priority as pendingEdit above and for the same
  // reason: the next message is almost certainly a direct answer to what
  // one of these flows just asked. Checked ahead of the generic
  // isCancelCommand/greeting handling further down so "cancel" reliably
  // cancels THIS flow instead of falling into the generic draft-cancel
  // path (which doesn't know these pending records exist).
  //
  // CONFIRMATION_WORDS/NEGATIVE_CONFIRMATION_WORDS are only tested once
  // entryId is set (i.e. truly awaiting a YES/NO) — while still
  // disambiguating (entryId null), a reply is never treated as a bare
  // yes/no. A leading filler word like "Okay" in "Okay, the one from
  // August 1st" would otherwise match CONFIRMATION_WORDS' anchored
  // leading-phrase pattern and short-circuit before the actual
  // disambiguation (the date) was ever read.
  if (pendingFlag) {
    if (isCancelCommand(content) || (pendingFlag.entryId && NEGATIVE_CONFIRMATION_WORDS.test(content.trim()))) {
      const result = await flagTransactionForReviewService.handleCancellation({ fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'CANCEL' };
    }
    if (pendingFlag.entryId) {
      if (CONFIRMATION_WORDS.test(content.trim())) {
        const result = await flagTransactionForReviewService.handleConfirmation({ fromNumber: cleanFromNumber, senderId });
        return { ...result, replyText: result.replyText, classification: 'FLAG_TRANSACTION' };
      }
    } else {
      const result = await flagTransactionForReviewService.handleDisambiguation({ text: content, fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'FLAG_TRANSACTION' };
    }
  }

  if (pendingClear) {
    if (isCancelCommand(content) || (pendingClear.entryId && NEGATIVE_CONFIRMATION_WORDS.test(content.trim()))) {
      const result = await clearFlaggedTransactionService.handleCancellation({ fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'CANCEL' };
    }
    if (pendingClear.entryId) {
      if (CONFIRMATION_WORDS.test(content.trim())) {
        const result = await clearFlaggedTransactionService.handleConfirmation({ fromNumber: cleanFromNumber, senderId });
        return { ...result, replyText: result.replyText, classification: 'CLEAR_FLAG' };
      }
    } else {
      const result = await clearFlaggedTransactionService.handleDisambiguation({ text: content, fromNumber: cleanFromNumber });
      return { ...result, replyText: result.replyText, classification: 'CLEAR_FLAG' };
    }
  }

  if (activeDraft && isGreetingMessage(content)) {
    const view = DraftFormatter.toDraftView(activeDraft);
    const replyText = DraftFormatter.formatActiveDraftInquiryMessage(view);
    return { replyText, state: 'PENDING_CONFIRMATION', pendingDraft: activeDraft, classification: 'GREETING' };
  }

  if (isGreetingMessage(content)) {
    const replyText = formatWelcomeMessage();
    return { replyText, classification: 'GREETING' };
  }

  if (isCancelCommand(content)) {
    const result = await DraftManager.handleCancel({ fromNumber: cleanFromNumber, knownProperties });
    await PendingStatement.deleteOne({ fromNumber: cleanFromNumber }).catch(() => {});
    const replyText = result?.replyText || 'Session cleared.';
    return { ...result, replyText, classification: 'CANCEL' };
  }

  if (pendingDeletion && CONFIRMATION_WORDS.test(content.trim())) {
    const result = await deleteLastTransactionService.handleConfirmation({ fromNumber: cleanFromNumber, senderId });
    return { ...result, replyText: result.replyText, classification: 'DELETE_LAST_TRANSACTION' };
  }

  if (pendingDeletion && NEGATIVE_CONFIRMATION_WORDS.test(content.trim())) {
    const result = await deleteLastTransactionService.handleCancellation({ fromNumber: cleanFromNumber });
    return { ...result, replyText: result.replyText, classification: 'CANCEL' };
  }

  if (isDeleteLastTransactionRequest(content)) {
    const result = await deleteLastTransactionService.handleDeleteRequest({ fromNumber: cleanFromNumber, senderId });
    return { ...result, replyText: result.replyText, classification: 'DELETE_LAST_TRANSACTION' };
  }

  if (isClearFlagRequest(content)) {
    const result = await clearFlaggedTransactionService.handleClearRequest({
      text: content,
      fromNumber: cleanFromNumber,
      senderId,
      knownProperties,
    });
    return { ...result, replyText: result.replyText, classification: 'CLEAR_FLAG' };
  }

  if (isFlagTransactionRequest(content)) {
    const result = await flagTransactionForReviewService.handleFlagRequest({
      text: content,
      fromNumber: cleanFromNumber,
      senderId,
      knownProperties,
    });
    return { ...result, replyText: result.replyText, classification: 'FLAG_TRANSACTION' };
  }

  // Task 3.3 — starts the edit flow (see the pendingEdit block at the very
  // top of this function for the rest of the conversation). Gated to only
  // fire when there's no active draft: "edit"/"correct" while a draft is
  // pending should always mean the draft, which is the existing,
  // well-tested behaviour lower down in this function.
  if (!activeDraft && isEditConfirmedTransactionRequest(content)) {
    const result = await editConfirmedTransactionService.handleEditRequest({
      text: content,
      fromNumber: cleanFromNumber,
      senderId,
      knownProperties,
    });
    return { ...result, replyText: result.replyText, classification: 'EDIT_TRANSACTION' };
  }

  // "Do I have any pending entries?" with NO active draft — answered
  // directly from the app's own state, with zero AI involvement. Previously
  // there was no handling for this at all when nothing was pending, so it
  // fell through to full QUERY intent classification and an AI call — one
  // that can (and did) fail outright if the AI provider is rate-limited or
  // unavailable, for a question the app could always answer for itself with
  // certainty. Deliberately narrow (unlike the broader activeDraft check
  // below) so it can't misfire on a genuine query like "check my rent
  // income" or "show me this month's summary" when nothing is pending.
  const isPendingStatusInquiry = !activeDraft
    && /\b(pending|unconfirmed|outstanding)\b/i.test(content)
    && /\b(entry|entries|draft|drafts|transaction|transactions)\b/i.test(content);

  if (isPendingStatusInquiry) {
    const replyText = DraftFormatter.formatNoPendingDraftMessage();
    return { replyText, state: 'NONE' };
  }

  if (activeDraft) {
    const isMetaInquiry = /(draft|pending|status|working on|check|what did i|show me|any entry)/i.test(content) && !/(cancel|save|confirm|yes|no|drop|change)/i.test(content);

    if (isMetaInquiry) {
      const view = DraftFormatter.toDraftView(activeDraft);
      const replyText = DraftFormatter.formatActiveDraftInquiryMessage(view);
      return { replyText, state: 'PENDING_CONFIRMATION', pendingDraft: activeDraft };
    }

    // A fresh, fully-formed transaction ("Paid 20k for plumbing at Flat
    // 2") is not an answer to "which property?" or "what category?" — it's
    // a brand new entry, whether typed or (especially) spoken, since a
    // voice note naturally restates the whole thing rather than answering
    // narrowly. Previously this branch consumed ANY message unconditionally
    // while a clarification was pending, so a new transaction arriving
    // mid-clarification got silently mangled into the stale draft (wrong
    // amount, wrong property, garbage description) instead of starting
    // clean. The isExplicitTransaction fast-path further below already
    // discards a stale draft correctly when this happens for a
    // PENDING_CONFIRMATION draft — this lets that same handling apply here.
    if (activeDraft?.clarification?.awaiting && !isExplicitTransaction(content)) {
      console.log('[DEBUG] Strict Intercept: Treating message as clarification answer.');
      const result = await DraftManager.handleClarification({
        fromNumber: cleanFromNumber,
        answer: content,
        knownProperties,
        referenceDate: new Date(),
      });

      return result;
    }

    const isLikelyConfirmation = CONFIRMATION_WORDS.test(content.trim());
    // FIX (§2a, 🔴 — duplicate of the MessageClassifier.js substring bug):
    // this regex was missing a LEADING \b, so "credit" matched "edit" as a
    // raw substring the same way it did in interpretDeterministic — a
    // fresh, unrelated transaction mentioning "credit" while a draft was
    // open got misread as an edit to that draft instead of starting a new
    // entry. Added the leading \b, and also suppress this check entirely
    // when the message itself carries a transaction signal (verb + amount,
    // via the same hasTransactionSignal used in MessageClassifier.js —
    // shared rather than re-implemented, so the two don't drift apart
    // again the way they did before).
    // FIX (manual WhatsApp testing): "How do I edit a past transaction?" —
    // a pure question, zero correction-relevant content — was matching
    // this purely because it contains the word "edit," and while a draft
    // was active that meant it got shoved through buildCorrectionPatch,
    // which then guessed something to change and stuffed the entire
    // question text into the draft's description field. The identical
    // question asked with NO draft active was answered correctly (routed
    // to isEditConfirmedTransactionRequest's graceful guidance message
    // instead), proving this was purely a phrasing-detection gap, not a
    // content one. looksLikeGenericQuestion (shared with
    // MessageClassifier.js's own equivalent CORRECTION guard, so the two
    // don't drift apart the same way hasTransactionSignal once did) now
    // excludes question-phrased messages from being treated as a
    // correction instruction.
    const isCorrectionRequest =
      !hasTransactionSignal(content.toLowerCase()) &&
      !looksLikeGenericQuestion(content) &&
      /\b(change|edit|update|switch|move|last month|yesterday|incorrect|wrong|make it)\b/i.test(content);

    if (!isLikelyConfirmation && isCorrectionRequest) {
      console.log('[DEBUG] Processing as draft correction or update.');
      const { patch, parseResult: correctionParseResult } = await buildCorrectionPatch(content, {
        knownProperties,
        // Fix (follow-up to Phase 6.3): same as the CORRECTION-intent
        // branch in routeByIntent — see buildCorrectionPatch.js.
        currentTransactionDate: activeDraft?.draftEntry?.transactionDate,
        // Fix (manual WhatsApp testing): same mismatch guard as the
        // CORRECTION-intent branch — see buildCorrectionPatch.js. This is
        // the exact code path that produced the "₦20,000 for fuel at
        // sunset villa" Frankenstein result in the transcript.
        currentDraftSummary: activeDraft
          ? DraftFormatter.formatTransactionPreview(activeDraft.draftEntry, knownProperties)
          : undefined,
      }).catch(() => ({ patch: {}, parseResult: {} }));

      if (correctionParseResult?.possibleMismatch) {
        const currentSummary = DraftFormatter.formatTransactionPreview(activeDraft.draftEntry, knownProperties);
        return {
          replyText: buildCorrectionMismatchReply(correctionParseResult, currentSummary),
        };
      }

      if (patch && Object.keys(patch).length > 0) {
        const result = await DraftManager.handleCorrection({
          fromNumber: cleanFromNumber,
          senderId,
          patch,
          knownProperties,
          referenceDate: new Date(),
        });
        return result;
      }
    }
  }

  if (isExplicitTransaction(content)) {
    console.log('[DEBUG] Pre-LLM fast-path triggered.');
    const { hadGreeting } = splitLeadingGreeting(content);
    const parsed = await parseTransaction(content, { knownProperties, senderId });
    const result = await handleParsedLogEntry({ parsed, fromNumber: cleanFromNumber, senderId, hadGreeting, knownProperties });
    return result;
  }

  const classification = await classifyMessage(content, { senderId });
  let intent = classification.intent || 'UNKNOWN';

  if (classification.aiUnavailable) {
    return { replyText: AI_BUSY_FALLBACK_MESSAGE };
  }

  if (intent === 'UNKNOWN') {
    try {
      const queryResult = await interpretQuery(content, { knownProperties, senderId });
      if (queryResult.queryType !== 'UNKNOWN') {
        intent = 'QUERY';
      }
    } catch (e) {
      console.log('[DEBUG] interpretQuery fallback failed:', e);
    }
  }

  const result = await routeByIntent({
    intent,
    text: content,
    fromNumber: cleanFromNumber,
    knownProperties,
    senderId,
    // FIX (Phase 1.5): forward whatever classifyMessage already fetched so
    // routeByIntent's GENERAL_INQUIRY/AFFIRMATION branches don't re-fetch
    // it — see those branches for details.
    context: { chatHistory: classification.chatHistory, recentTransactions: classification.recentTransactions },
    // Phase 6.1: lets the QUERY/STATEMENT_REQUEST branches mention a
    // pending draft the user is switching away from — see
    // withDraftContinuityNote above.
    activeDraft,
  });

  return result;
}

export async function processMessageContent({ content, fromNumber }) {
  console.log('[DEBUG] processMessageContent started');

  const cleanFromNumber = normalizePhoneNumber(fromNumber);
  const senderId = cleanFromNumber;

  // FIX (Phase 1.4, 🔴 — confirmed live): these four lookups used to run
  // one after another even though none of them depends on another's
  // result — getKnownProperties, saveChatMessage, findOrCreateUser, and
  // getActiveDraft are all independent reads/writes keyed off senderId /
  // cleanFromNumber alone. Running them sequentially just adds up their
  // individual latencies for no reason. saveChatMessage's own
  // fire-and-log-a-warning error handling is preserved exactly (a failure
  // to save the user's chat message must never abort the whole turn) —
  // it's just expressed as a .catch() on its own promise now, so it can
  // run alongside the other three instead of blocking them.
  const [knownProperties, , { isNewUser }, activeDraft] = await Promise.all([
    getKnownProperties(senderId),
    saveChatMessage(senderId, 'user', content).catch((err) => {
      console.warn('[DEBUG] Failed to save user chat message:', err);
      return null;
    }),
    findOrCreateUser(cleanFromNumber),
    getActiveDraft(cleanFromNumber),
  ]);

  const rawResult = await resolvePipelineResult({ content, cleanFromNumber, senderId, knownProperties, activeDraft });
  const result = decorateForNewUser(rawResult, isNewUser);

  // PERF FIX: this write already tolerates its own failure (see
  // saveAssistantMessage's try/catch below) and nothing downstream in this
  // request depends on it having finished — the reply is fully formed and
  // ready to send the moment resolvePipelineResult returns. Awaiting it
  // here just meant every single reply sat behind one extra DB round trip
  // before the caller could hand it to sendWhatsAppText. Letting it run in
  // the background shaves that write off the critical path to the user's
  // phone on every message, with no change in behavior beyond it landing
  // in chat history a few milliseconds later than the reply itself did.
  if (result?.replyText) {
    saveAssistantMessage(senderId, result.replyText);
  }

  return result;
}

async function saveAssistantMessage(senderId, text) {
  try {
    await saveChatMessage(senderId, 'assistant', text);
  } catch (err) {
    console.warn('[DEBUG] Failed to save assistant chat message:', err);
  }
}

export default {
  isCancelCommand,
  isConfirmationWord,
  isNegativeConfirmationWord,
  isExplicitTransaction,
  splitLeadingGreeting,
  routeByIntent,
  processMessageContent,
}