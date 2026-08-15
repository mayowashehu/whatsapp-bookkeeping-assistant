import { SYSTEM_MANUAL } from './systemManual.js';
import env from '../config/env.js';

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
- Always confirm before saving any transaction.`;

const EMPATHY_RULES = `1. If the user expresses frustration ("I'm confused", "How do I do this", "This isn't working"), acknowledge their confusion first and provide ONLY Step 1 of the correct process (never a wall of text).
2. If the user's request is ambiguous ("Log my property"), ask polite, specific follow-up questions to clarify.
3. Always base your answers on real data from the context window.`;

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

export function buildInquirySystemPrompt({ chatHistory = [], recentTransactions = [], unclear = false } = {}) {
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

SYSTEM MANUAL - READ THIS CAREFULLY:
${SYSTEM_MANUAL}

You are the system concierge. Use the System Manual above to give clear, micro-step instructions with concrete copy-paste examples. Never invent unlisted features. Keep answers concise, actionable, and formatted using bold markers (*text*) for readability on WhatsApp.
${unclear ? `\n${UNCLEAR_MESSAGE_RULES}` : ''}`;
}

export default { buildContextualSystemPrompt, APP_CAPABILITIES, buildInquirySystemPrompt };