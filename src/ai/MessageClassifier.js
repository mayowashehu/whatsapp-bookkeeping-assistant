import env from '../config/env.js';
import { isAiUnavailableError } from './aiFallback.js';
import { createAIService } from './createAIService.js';
import {
  CLASSIFY_MESSAGE_SYSTEM_PROMPT,
  CLASSIFY_MESSAGE_SCHEMA_HINT,
} from '../prompts/classifyMessage.js';
import { buildContextualSystemPrompt } from '../prompts/contextPromptBuilder.js';
import { getConversationContext, getRecentTransactions } from '../services/ContextService.js';

export const CLASSIFICATION_INTENTS = Object.freeze([
  'LOG_ENTRY',
  'QUERY',
  'CONFIRMATION',
  'CORRECTION',
  'DELETE_LAST_TRANSACTION',
  'FLAG_TRANSACTION',
  'CLEAR_FLAG',
  'EDIT_TRANSACTION',
  'STATEMENT_REQUEST',
  'GREETING',
  'GENERAL_INQUIRY',
  'AFFIRMATION',
  'UNKNOWN',
]);

const GREETING_PATTERN = /^(hi|hello|hey|are you there|ping|status|test)$/i;
const AFFIRMATION_PATTERN = /^(yes|yes i do|yes please|sure|sure thing|let's go|lets go|okay|ok|alright|go ahead|please do|i do)$/i;

// FIX (§2a/§2b, 🔴 headline finding): the CORRECTION and QUERY deterministic
// patterns below used to fire on ordinary financial words purely because
// they appear ANYWHERE in the message — "credit" tripped the CORRECTION
// block because it contains the substring "edit" (via .includes()), and
// "rent"/"spent"/"received" in the QUERY pattern list matched real
// transaction descriptions just as readily as real questions. Two separate
// fixes are combined here:
//
// 1. Word-boundary matching (\b...\b) instead of raw .includes() — this
//    alone fixes the pure substring accidents: "credit" no longer matches
//    "edit", "undocumented" no longer matches "undo".
//
// 2. A "this message describes a fresh transaction" signal
//    (hasTransactionSignal) that suppresses BOTH the CORRECTION and QUERY
//    deterministic checks. Word-boundary matching alone doesn't help when
//    the trigger word is a genuine whole word that's still ambiguous in
//    context — "Received a credit of 200k from tenant" contains the real
//    whole word "credit" (not a match after the boundary fix, since
//    "credit" itself was never a listed keyword — only "edit" was), but
//    "I got change of 500 naira from the market" contains the real whole
//    word "change", which IS a listed correction keyword. A message that
//    also carries a transaction verb ("got", "received", "paid", ...) and
//    a money amount is overwhelmingly more likely to be a fresh
//    transaction than an edit request or a question — so when both are
//    present, we skip the CORRECTION/QUERY deterministic shortcuts
//    entirely and let the AI classifier (which has full sentence context)
//    decide, instead of guessing wrong with high confidence.
//
// This does NOT change behavior for genuinely ambiguous cases with no
// transaction signal at all (e.g. bare "Rent" or "Change of 500 from
// vendor" with no verb/amount pairing) — those remain intentionally
// unresolved here, same as before, since no deterministic rule can safely
// disambiguate them without more context.
// Bug fix (data-loss finding from manual WhatsApp testing): a real
// transaction like "Add 20k rent for Orchid property, log this" was being
// classified as QUERY instead of logged — the 20k was silently never
// saved. Root cause: this pattern never recognized "add"/"log"/"record"/
// "enter" as transaction-indicating verbs, so hasTransactionSignal()
// returned false for a message that plainly describes a real transaction,
// and the QUERY/GENERAL_INQUIRY guards (which only step aside when this
// function returns true) never engaged. Added with a leading \b so these
// don't misfire on unrelated uses of very common words — the amount
// requirement (MONEY_AMOUNT_PATTERN must ALSO match) already does most of
// that work, since a bare "add" or "log" alone still won't trip this.
// Bug fix (manual WhatsApp testing): "Mo gba 50,000 for rent at Flat 2
// today" (Yoruba "Mo gba" = "I received/collected") was misclassified as
// QUERY and the transaction was never logged — this pattern is
// English-only, so a non-English transaction verb makes
// hasTransactionSignal() return false even though the message plainly
// describes a real transaction, and the QUERY guard never engaged.
//
// Deliberately narrow: only "gba" (Yoruba, receive/collect/get) and "get"
// (very common in Nigerian Pidgin — "I get 5k from am") are added here.
// This is NOT meant to be comprehensive multi-language coverage — going
// much further risks false positives from words that double as property
// names or unrelated vocabulary (e.g. a candidate considered and rejected:
// "san," Yoruba for "pay," which is also a common substring in place names
// like "San Francisco"). This closes the specific, demonstrated gap;
// broader coverage is better built later from real usage patterns (which
// messages actually needed it) than guessed at broadly now.
const TRANSACTION_VERB_PATTERN =
  /\b(receiv(?:ed|ing|e)?|reciev(?:ed|d)?|reciv(?:ed|ing|e)?|receveid|got|gotten|get|made|collected|spe?nt|spet|pa(?:id|yed)|transfer(?:red|ing|s)?|credit(?:ed)?|debit(?:ed)?|add(?:ed|ing)?|log(?:ged|ging)?|record(?:ed|ing)?|enter(?:ed|ing)?|gba)\b/i;
export const MONEY_AMOUNT_PATTERN = /\b\d[\d.,]*\s*(?:million|m|billion|b|thousand|k|naira|ngn)?\b/i;
// Covers "change of 500 from vendor" / "got change of 500 naira" — a
// common phrasing for physical change received that would otherwise be
// caught by the bare \bchange\b correction keyword below.
const CHANGE_OF_AMOUNT_PATTERN = /\bchange\s+of\s+\d/i;

// Exported so other call sites that independently guess at "is this a
// correction?" (e.g. messageHandlerShared.js's active-draft correction
// heuristic) can share this exact signal instead of re-implementing their
// own drifting copy — which is how the §2a substring bug ended up
// duplicated in two files in the first place.
export function hasTransactionSignal(text) {
  return (TRANSACTION_VERB_PATTERN.test(text) && MONEY_AMOUNT_PATTERN.test(text)) || CHANGE_OF_AMOUNT_PATTERN.test(text);
}

// Bug fix (manual WhatsApp testing): "How do I edit a past transaction?" —
// a pure question with zero correction-relevant content — was getting
// treated as a correction INSTRUCTION whenever a draft happened to be
// active, because the correction-detection regexes only ever check for
// the presence of a trigger word ("edit"/"change"/etc.), never whether the
// message is actually phrased as a question rather than an instruction.
// The exact same question asked with no draft active was answered
// correctly, proving the bug was purely about phrasing detection, not
// content. Exported so both this file's own deterministic CORRECTION
// block and messageHandlerShared.js's local isCorrectionRequest check
// (used inside the active-draft branch, which is what actually broke in
// the transcript) share one definition instead of two independently
// drifting ones — the same lesson already learned once from the
// hasTransactionSignal duplication bug referenced above.
//
// Deliberately conservative: a message with a concrete amount in it is
// almost certainly an instruction ("Edit the amount to 20k, is that
// right?"), not a pure question, so the presence of an amount always wins
// and this returns false regardless of phrasing.
const GENERIC_QUESTION_START_PATTERN = /^(how|what|why|when|where|who|which|can|could|do|does|is|are|will|would|should)\b/i;

export function looksLikeGenericQuestion(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (MONEY_AMOUNT_PATTERN.test(clean)) return false;
  return GENERIC_QUESTION_START_PATTERN.test(clean) || /\?\s*$/.test(clean);
}

function lastAssistantAskedProposal(chatHistory = []) {
  const lastAssistantMessage = [...chatHistory]
    .reverse()
    .find((message) => message?.role === 'assistant' && typeof message?.content === 'string');

  if (!lastAssistantMessage) {
    return false;
  }

  return /(would you like|do you want|shall we|should i|can i help you|try logging|log one now|log a transaction|run a report|generate a report|generate a statement)/i.test(
    lastAssistantMessage.content,
  );
}

/**
 * Deterministically classify common intents without AI
 * @param {string} lowerText
 */
function interpretDeterministic(lowerText, chatHistory = []) {
  const trimmed = lowerText.trim();

  if (GREETING_PATTERN.test(trimmed)) {
    return { intent: 'GREETING', confidence: 0.99, reasoning: 'Matched greeting pattern.' };
  }

  if (AFFIRMATION_PATTERN.test(trimmed) && lastAssistantAskedProposal(chatHistory)) {
    return {
      intent: 'AFFIRMATION',
      confidence: 0.98,
      reasoning: 'Matched affirmative reply to prior assistant proposal.',
    };
  }

  // Confirmation first — only if no prior proposal to avoid conflict with AFFIRMATION
  if (/^(yes|ok|okay|confirm|correct|sure|yep|yes i do|go ahead|please do)$/i.test(trimmed) && !lastAssistantAskedProposal(chatHistory)) {
    return { intent: 'CONFIRMATION', confidence: 0.99, reasoning: 'Matched confirmation pattern.' };
  }
  if (/\b(delete|remove|undo)\b/.test(lowerText) && /\b(last|most recent)\b/.test(lowerText) && /\b(transaction|entry|one)\b/.test(lowerText)) {
    return { intent: 'DELETE_LAST_TRANSACTION', confidence: 0.95, reasoning: 'Matched delete-last-transaction request.' };
  }
  // Task 3.3 — "the flag is resolved" companion, checked before the flag
  // pattern so "mark as reviewed" (once it's done being checked) resolves
  // distinctly from "mark for review" (still needs checking). Mirrors
  // isClearFlagRequest in messageHandlerShared.js.
  if (
    /\bunflag\b/.test(lowerText) ||
    (/\b(clear|remove)\b/.test(lowerText) && /\bflag\b/.test(lowerText)) ||
    /\breviewed\b/.test(lowerText)
  ) {
    return { intent: 'CLEAR_FLAG', confidence: 0.9, reasoning: 'Matched clear-flag request.' };
  }
  // Task 3.2: a path for editing an ALREADY-CONFIRMED transaction (not just
  // undoing the last one). Follow-up fix: originally required a
  // "review"-ish companion word alongside "flag"/"mark", but real usage is
  // often just "Flag my transaction with expense of 50k at orchid" with no
  // "review" wording at all. "flag" alone as a verb is rare enough in
  // ordinary bookkeeping text to be safe as a standalone trigger; "mark"
  // alone is not (e.g. "mark this paid" means something else), so it still
  // needs the review-ish companion word.
  if (/\bflag\b/.test(lowerText)) {
    return { intent: 'FLAG_TRANSACTION', confidence: 0.9, reasoning: 'Matched flag-for-review request.' };
  }
  if (
    /\bmark\b/.test(lowerText) &&
    /\b(review|recheck|re-check|double[- ]check|manual review|check (?:this|it) again|look (?:at )?(?:this|it) again)\b/.test(lowerText)
  ) {
    return { intent: 'FLAG_TRANSACTION', confidence: 0.9, reasoning: 'Matched flag-for-review request.' };
  }
  // Task 3.3 — locating an already-confirmed transaction to edit is
  // deliberately NOT resolved here. "edit/fix/correct" overlaps almost
  // entirely with the CORRECTION pattern immediately below (which
  // legitimately needs to catch those same bare words for draft
  // correction), and CORRECTION's broader match would never let this fire
  // if placed after it, while placing it before would shadow CORRECTION
  // for messages that have nothing to do with an old confirmed entry.
  // messageHandlerShared.js's own isEditConfirmedTransactionRequest check
  // is the real gate for this feature instead — it knows whether a draft
  // is active (CORRECTION's territory) or not (this feature's territory),
  // which this deterministic layer has no visibility into.
  // Correction — see hasTransactionSignal comment above for why the
  // .includes() checks were replaced with \b-anchored ones, and why a
  // detected transaction signal suppresses this block entirely.
  const transactionSignal = hasTransactionSignal(lowerText);
  if (
    !transactionSignal &&
    !looksLikeGenericQuestion(lowerText) &&
    (/^(cancel|discard|abort|never mind|nevermind|forget it|stop|undo|delete|edit|change|correct)$/.test(lowerText) ||
      /\bchange\b/.test(lowerText) ||
      /\bcorrect\b/.test(lowerText) ||
      /\bedit\b/.test(lowerText) ||
      /\bundo\b/.test(lowerText) ||
      /\bdelete\b/.test(lowerText))
  ) {
    return { intent: 'CORRECTION', confidence: 0.9, reasoning: 'Matched correction pattern.' };
  }
  // Statement request
  if (lowerText.includes('statement') || lowerText.includes('pdf') || lowerText.includes('report') || lowerText.includes('generate') && (lowerText.includes('monthly') || lowerText.includes('statement'))) {
    return { intent: 'STATEMENT_REQUEST', confidence: 0.9, reasoning: 'Matched statement request pattern.' };
  }
  // Query patterns — "spent"/"received"/"rent" describe transactions just
  // as often as they ask about them, so (per hasTransactionSignal above) a
  // message that also carries a verb+amount pair is treated as a fresh
  // transaction, not a query, and falls through to the AI classifier.
  const queryPatterns = [
    /\bhow much\b/,
    /\btotal\b/,
    /\binexpense\b/,
    /\bexpense\b/,
    /\bincome\b/,
    /\bspent\b/,
    /\breceived\b/,
    /\bnet\b/,
    /\blast transaction\b/,
    /\blast transactions\b/,
    // Task 3.3: "show my flagged transactions" has no amount/verb signal
    // and isn't a correction, so on its own it wouldn't hit any
    // deterministic bucket and would fall through to a full AI call for
    // something this app already knows the answer to with certainty.
    /\bflagged\b/,
    /\bmy properties\b/,
    /\bwhat are my properties\b/,
    /\blist my properties\b/,
    /\bbiggest\b/,
    /\bcategory\b/,
    /\brent\b/,
    /\bcame in\b/,
    /\bsummary\b/,
    /\beverything\b/
  ];
  if (!transactionSignal && queryPatterns.some(p => p.test(lowerText))) {
    return { intent: 'QUERY', confidence: 0.95, reasoning: 'Matched query pattern.' };
  }
  // General inquiry patterns (how-to, help, guidance, capabilities, add property, confusion)
  // Audit fix: this block was missing the same `!transactionSignal` guard
  // that the CORRECTION and QUERY blocks above already have (see the
  // detailed comment on hasTransactionSignal at the top of this file for
  // why that guard exists). Without it, a genuine transaction that happens
  // to contain any of these very common words — "Add 20k rent for Orchid
  // property", "Paid 5k, log this expense", "How much I paid the plumber,
  // 15k" — was being misclassified as GENERAL_INQUIRY and answered with
  // capability text instead of actually being logged. A message carrying a
  // real transaction verb + amount is overwhelmingly more likely to be a
  // fresh transaction than a how-to question, exactly the same reasoning
  // already applied to CORRECTION/QUERY above.
  const inquiryPatterns = [
    /\bhow to\b/,
    /\bhow do i\b/,
    /\bcan you help\b/,
    /\bhelp me\b/,
    /\bwhat can you do\b/,
    /\bwhat do you do\b/,
    /\bhow does this work\b/,
    /\bguide me\b/,
    /\binstructions\b/,
    /\btutorial\b/,
    /\bshow me how\b/,
    /\buse this\b/,
    /\bhow to use\b/,
    /\bhow\b/,
    /\bproperty\b/,
    /\badd\b/,
    /\bconfused\b/,
    /\bhelp\b/,
    /\blog\b/
  ];
  if (!transactionSignal && inquiryPatterns.some(p => p.test(lowerText))) {
    return { intent: 'GENERAL_INQUIRY', confidence: 0.95, reasoning: 'Matched general inquiry pattern.' };
  }
  return null;
}

/**
 * Classifies user intent only.
 * Depends solely on the generic AIService contract — never on a concrete provider.
 *
 * @param {string} text
 * @param {{ aiService?: import('./AIService.js').AIService }} [options]
 * @returns {Promise<{ intent: string, confidence: number, reasoning: string }>}
 */
export async function classifyMessage(text, options = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (!trimmed) {
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      reasoning: 'Empty input.',
      chatHistory: [],
      recentTransactions: [],
    };
  }

  // Fetch conversation history up front — interpretDeterministic below
  // needs it for the AFFIRMATION check (lastAssistantAskedProposal).
  let chatHistory = [];
  if (options.senderId) {
    chatHistory = await getConversationContext(options.senderId);
  }

  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const deterministic = interpretDeterministic(lower, chatHistory);
  if (deterministic) {
    // FIX (Phase 1.0e, 🔴 — confirmed live): recentTransactions used to be
    // fetched unconditionally above, before interpretDeterministic ran,
    // even though it's only ever used to build the AI system prompt
    // further down. Every message resolved deterministically (the large
    // majority — LOG_ENTRY/QUERY/CORRECTION/etc. never reach the AI call
    // at all) paid for that DB round-trip for nothing. It's simply
    // omitted here now; callers that need it for a specific deterministic
    // intent (see messageHandlerShared.js's GENERAL_INQUIRY/AFFIRMATION
    // handling) fetch it themselves in that narrower case, once.
    return { ...deterministic, chatHistory, recentTransactions: undefined };
  }

  // Only reached when no deterministic rule could resolve the intent —
  // this is the one path that actually needs recentTransactions, so fetch
  // it now rather than unconditionally at the top of the function.
  let recentTransactions = [];
  if (options.senderId) {
    recentTransactions = await getRecentTransactions(options.senderId);
  }

  const aiService = options.aiService || createAIService();

  // Build contextual system prompt
  const contextualSystemPrompt = buildContextualSystemPrompt(CLASSIFY_MESSAGE_SYSTEM_PROMPT, {
    chatHistory,
    recentTransactions
  });

  let raw;
  try {
    raw = await aiService.completeJson({
      system: contextualSystemPrompt,
      user: trimmed,
      schemaHint: CLASSIFY_MESSAGE_SCHEMA_HINT,
    });
  } catch (err) {
    if (isAiUnavailableError(err)) {
      return {
        intent: 'UNKNOWN',
        confidence: 0,
        reasoning: err.message,
        aiUnavailable: true,
        chatHistory,
        recentTransactions,
      };
    }
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      reasoning: `Classification provider failure: ${err.message}`,
      chatHistory,
      recentTransactions,
    };
  }

  return { ...normalizeClassification(raw, env.classificationMinConfidence), chatHistory, recentTransactions };
}

/**
 * Validates and normalizes provider JSON. Never trusts AI output blindly.
 * Exported for deterministic demonstration / tests without calling the AI provider.
 */
export function normalizeClassification(raw, minConfidence = 0.7) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return unknownResult('Malformed classification payload.');
  }

  const intent = typeof raw.intent === 'string' ? raw.intent.trim().toUpperCase() : null;
  const confidence = normalizeConfidence(raw.confidence);
  const reasoning =
    typeof raw.reasoning === 'string' && raw.reasoning.trim()
      ? raw.reasoning.trim()
      : 'No reasoning provided.';

  if (!intent || !CLASSIFICATION_INTENTS.includes(intent)) {
    return {
      intent: 'UNKNOWN',
      confidence: confidence ?? 0,
      reasoning: `Unsupported or missing intent: ${String(raw.intent)}.`,
    };
  }

  if (confidence === null) {
    return {
      intent: 'UNKNOWN',
      confidence: 0,
      reasoning: 'Missing or invalid confidence; refusing to guess.',
    };
  }

  if (intent !== 'UNKNOWN' && confidence < minConfidence) {
    return {
      intent: 'UNKNOWN',
      confidence,
      reasoning: `Low confidence (${confidence} < ${minConfidence}): ${reasoning}`,
    };
  }

  return {
    intent,
    confidence,
    reasoning,
  };
}

function normalizeConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

function unknownResult(reasoning) {
  return {
    intent: 'UNKNOWN',
    confidence: 0,
    reasoning,
  };
}

export default {
  classifyMessage,
  normalizeClassification,
  CLASSIFICATION_INTENTS,
  hasTransactionSignal,
};