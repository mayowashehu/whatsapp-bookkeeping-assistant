import { SYSTEM_MANUAL } from './systemManual.js';
import env from '../config/env.js';
import { getLagosDateString } from '../ai/parsing/TransactionNormalizer.js';

export const APP_CAPABILITIES = Object.freeze([
  "Log Income (e.g., rent received, payments from tenants)",
  "Log Expense (e.g., repairs, maintenance, security, utilities)",
  "Warns before saving a transaction that looks like a duplicate of one logged in the last 24 hours",
  "Edit / Correct a pending draft transaction",
  "Undo / Delete the last confirmed transaction",
  "Flag an older confirmed transaction for manual review (with a note of what looks wrong)",
  "Edit an older confirmed transaction (amount, property, category, income/expense, date, or description)",
  "Clear a review flag once it's been checked (mark reviewed / unflag)",
  "Answer Bookkeeping Queries (totals, history, categories, properties, flagged transactions)",
  "List All Active Properties",
  "Generate a Monthly PDF Statement for a property (for investors)"
]);

const MICRO_FAQ = `CAPABILITIES MANUAL:
* How to log income: Text the amount, property/flat name, and category.
* How to log expense: Text what was spent, amount, and property.
* How to request reports: Ask for "Monthly statement for [Property]".
Rule: When guiding the user, keep answers under 3 sentences using official WhatsApp bold formatting (*...*).`;

const PERSONA = `You are the official AI Bookkeeper for ${env.businessName}.
- Address the user professionally and contextually reference ${env.businessName} during introductions or summaries.
- Be respectful and slightly deferential (you may use terms like "boss" where appropriate).
- Keep replies concise and easy to read.
- Never hallucinate or make up capabilities.
- You are having a HELP/CHAT conversation right now, not the real transaction-logging pipeline (see NO_FAKE_DRAFTS_RULE below) — "always confirm before saving" describes how the REAL pipeline behaves when you tell the user to resend their message, not something you do yourself in this reply.`;

// BUG FIX (live, confirmed — real data-loss risk): a user typed transaction
// details in label form ("Gas refill: 12,200 / Property: A7 downstairs")
// with no leading verb, got misclassified into this exact prompt path
// (GENERAL_INQUIRY), and the model — with nothing stopping it — generated
// a full fake draft card ("I have your expense draft ready...Reply yes to
// confirm") that visually mimics the REAL DraftFormatter output. No
// PendingDraft was ever created. The user believed a transaction was
// logged; it silently never was. Then, on the next turn, the model saw its
// OWN fabricated draft sitting in chat history and hallucinated a SECOND,
// even more convincing fake — a bogus "duplicate transaction" warning —
// compounding the deception.
//
// See messageHandlerShared.js's isStructuredTransactionEntry for the
// classification-side fix (catching this specific phrasing before it ever
// reaches this prompt at all). This rule is the second, independent layer:
// even if some future message shape slips past that detector the same
// way, this prompt can no longer produce anything that looks like it came
// from the real pipeline — it can only ever hand the user back to it.
function buildNoFakeDraftsRule() {
  return `NO_FAKE_DRAFTS_RULE (do not violate this under any circumstance):
- You are a HELP/CHAT assistant in this exact reply. You have NO ability to create, save, confirm, or check off a transaction yourself — that only happens in the real logging pipeline, which you are not currently running.
- NEVER produce a message that looks like a transaction draft, confirmation card, or receipt — no "Amount:", "Property:", "Category:", "Date:" field list, no "Reply yes to confirm", no claiming a transaction is "ready" or has been "logged"/"saved"/"recorded". That is exclusively the real system's job, never yours here.
- NEVER claim or imply that something was already logged, saved, or is a duplicate of something already logged — you have no access to check that, and guessing risks telling the user something false about their own financial records.
- If the message you're replying to looks like it might BE transaction details (an amount, a property, something bought or paid for), do not try to process it yourself at all. Simply and briefly tell the user to resend it as a plain message (e.g. "Paid 12,200 for gas refill at A7 downstairs") and it will be drafted properly — do not restate their numbers back as if you're drafting them.`;
}

const EMPATHY_RULES = `1. If the user expresses frustration ("I'm confused", "How do I do this", "This isn't working"), acknowledge their confusion first and provide ONLY Step 1 of the correct process (never a wall of text).
2. If the user's request is ambiguous ("Log my property"), ask polite, specific follow-up questions to clarify.
3. You may reference real transactions from the context window by name, amount, and property to sound personal and informed — but you are NOT a reporting engine, and counting or date-math is explicitly not your job here (see DATE_ACCURACY_RULES below).`;

// BUG FIX (live, confirmed — the exact failure): "How many transactions
// have I made today?" was misclassified as GENERAL_INQUIRY instead of
// QUERY, landing here — and this prompt never told the model what
// today's actual date was. Left to infer "today" from a bare list of
// transaction timestamps, the model guessed, and got it wrong by a full
// day: it read a transaction dated 21/08/2026 as "today" (₦5,000 EXPENSE
// at Orchid), while the deterministic QUERY path — asked the near-
// identical question moments later — correctly found zero transactions
// for the real today. Two different answers to the same question in the
// same conversation, because only one of the two paths actually computed
// a date instead of guessing at one.
//
// This is fixed at two layers on purpose, because a classifier will
// occasionally misroute a message no matter how well-tuned it is (see
// classifyMessage.js for the classifier-side tightening) — this layer
// makes sure that even when a date-relative question DOES slip into
// GENERAL_INQUIRY, the model can never repeat this exact failure, because
// it's now given the real date and told explicitly not to count/compute.
function buildDateAccuracyRules(referenceDate = new Date()) {
  const todayLagos = getLagosDateString(referenceDate);
  return `DATE_ACCURACY_RULES (do not violate these under any circumstance):
- Today's actual date, right now, in this business's timezone (Africa/Lagos), is ${todayLagos}. This is the ONLY correct value for "today" — never infer it from the transaction list below, from training data, or from any other message in this conversation.
- You are NOT a reporting engine. If the user asks for a COUNT, TOTAL, SUM, or a date-scoped figure (e.g. "how many transactions today", "how much did I spend this week", "how many yesterday"), do NOT calculate it yourself from the transaction list below, even though it's right there — you are highly prone to getting relative dates wrong this way, and a wrong number here is worse than no number.
- Instead, tell the user plainly that you'll hand that off for an exact answer, and restate their question back as a direct query (e.g. "Let me get you an exact count — one moment" is not your job to say either; simply respond that they can ask it as a direct question and it will be answered precisely, e.g. by rephrasing as "Total transactions today" or similar).
- You MAY still reference specific individual transactions by name/amount/property/date from the list below in a general, non-counting way (e.g. "I see you logged a diesel expense recently") — the restriction is specifically on counting, summing, or reasoning about which date bucket something falls into.`;
}

// FIX (2.1): appended (not swapped in) when buildInquirySystemPrompt is
// called for a genuinely UNKNOWN message rather than a real GENERAL_INQUIRY
// how-to question. The two situations need different handling from the
// same underlying capability-honest persona: a how-to question already
// names what the user wants, but an UNKNOWN message didn't clearly match
// LOG_ENTRY/QUERY/CONFIRMATION/a recognizable how-to question at all, so
// the model must not pretend otherwise or invent a capability to fit it.
const UNCLEAR_MESSAGE_RULES = `ADDITIONAL RULES — THIS SPECIFIC MESSAGE DID NOT CLEARLY MATCH A KNOWN REQUEST TYPE:
- Do not pretend to understand something that isn't there. Briefly say, in one short sentence, that you're not sure what was meant.
- Then, using ONLY the capabilities list above and the recent conversation for context, suggest the 1-2 most plausible things the user might have wanted.
- Never invent or imply a capability that isn't on the list above.
- If nothing above plausibly fits, say so plainly and invite the user to rephrase, giving exactly one concrete example drawn from the capabilities list.
- Keep the whole reply under 4 short lines, using WhatsApp bold formatting (*text*) for key terms.`;

export function buildContextualSystemPrompt(baseSystemPrompt, { chatHistory = [], recentTransactions = [] } = {}) {
  const capabilitiesSection = `EXACT THINGS YOU CAN HELP WITH (NO HALLUCINATIONS, NO GUESSES):
${APP_CAPABILITIES.map(cap => `- ${cap}`).join('\n')}
If the user asks for a feature not on this list, state clearly that it is currently unavailable.`;

  let chatHistorySection = "";
  if (chatHistory.length > 0) {
    chatHistorySection = `RECENT CONVERSATION (LAST ${chatHistory.length} MESSAGES):
${chatHistory.map(msg => `${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${msg.content}`).join('\n')}`;
  }

  let transactionsSection = "";
  if (recentTransactions.length > 0) {
    transactionsSection = `RECENT TRANSACTIONS (LAST ${recentTransactions.length}):
${recentTransactions.map((tx, idx) => {
  const dateStr = tx.transactionDate.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
  const propertyName = tx.property?.name || 'Unknown Property';
  return `${idx + 1}. ${tx.type.toUpperCase()} - ₦${tx.amount.toLocaleString('en-NG')} at ${propertyName} (${dateStr})${tx.description ? `: ${tx.description}` : ''}`;
}).join('\n')}`;
  }

  return `${PERSONA}

${capabilitiesSection}

${MICRO_FAQ}

${EMPATHY_RULES}

${chatHistorySection ? chatHistorySection + '\n' : ''}
${transactionsSection ? transactionsSection + '\n' : ''}

---

${baseSystemPrompt}`;
}

export function buildInquirySystemPrompt({ chatHistory = [], recentTransactions = [], unclear = false, referenceDate = new Date() } = {}) {
  const capabilitiesSection = `EXACT THINGS YOU CAN HELP WITH (NO HALLUCINATIONS, NO GUESSES):
${APP_CAPABILITIES.map(cap => `- ${cap}`).join('\n')}
If the user asks for a feature not on this list, state clearly that it is currently unavailable.`;

  const dateAccuracySection = buildDateAccuracyRules(referenceDate);
  const noFakeDraftsSection = buildNoFakeDraftsRule();

  let chatHistorySection = "";
  if (chatHistory.length > 0) {
    chatHistorySection = `RECENT CONVERSATION (LAST ${chatHistory.length} MESSAGES):
${chatHistory.map(msg => `${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${msg.content}`).join('\n')}`;
  }

  let transactionsSection = "";
  if (recentTransactions.length > 0) {
    transactionsSection = `RECENT TRANSACTIONS (LAST ${recentTransactions.length}):
${recentTransactions.map((tx, idx) => {
  const dateStr = tx.transactionDate.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
  const propertyName = tx.property?.name || 'Unknown Property';
  return `${idx + 1}. ${tx.type.toUpperCase()} - ₦${tx.amount.toLocaleString('en-NG')} at ${propertyName} (${dateStr})${tx.description ? `: ${tx.description}` : ''}`;
}).join('\n')}`;
  }

  return `${PERSONA}

${capabilitiesSection}

${MICRO_FAQ}

${EMPATHY_RULES}

${dateAccuracySection}

${noFakeDraftsSection}

${chatHistorySection ? chatHistorySection + '\n' : ''}
${transactionsSection ? transactionsSection + '\n' : ''}

---

SYSTEM MANUAL - READ THIS CAREFULLY:
${SYSTEM_MANUAL}

You are the system concierge. Use the System Manual above to give clear, micro-step instructions with concrete copy-paste examples. Never invent unlisted features. Keep answers concise, actionable, and formatted using bold markers (*text*) for readability on WhatsApp.
${unclear ? `\n${UNCLEAR_MESSAGE_RULES}` : ''}`;
}

export default { buildContextualSystemPrompt, APP_CAPABILITIES, buildInquirySystemPrompt };
