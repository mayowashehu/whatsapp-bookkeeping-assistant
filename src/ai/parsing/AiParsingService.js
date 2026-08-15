import env from '../../config/env.js';
import { createAIService } from '../createAIService.js';
import {
  PARSE_TRANSACTION_SCHEMA_HINT,
  buildParseTransactionSystemPrompt,
} from '../../prompts/parseTransaction.js';
import { buildContextualSystemPrompt } from '../../prompts/contextPromptBuilder.js';
import { getConversationContext, getRecentTransactions } from '../../services/ContextService.js';

// FIX (Phase 1.0e, 🔴 — confirmed live): this call used to attach chat
// history (8 messages) + recent transactions (5) + the full known-property
// list + persona/capabilities boilerplate to EVERY parse call, even for a
// clean, fully self-contained message like "Paid 20k for repairs at
// Orchid" that never references anything outside itself. That both (a)
// cost two extra sequential DB reads per parse call and (b) inflated the
// token payload sent to the model on every single request, for context the
// model never needed.
//
// This pattern detects the cases where the message actually DOES rely on
// something outside itself — a relative/deictic reference ("that", "it",
// "same as before", "again", "the usual", "like last time") that only
// resolves against prior conversation or a prior transaction. Only those
// messages pay for the context fetch + the larger prompt; a plain,
// self-describing transaction skips both entirely.
const CONTEXT_REFERENCE_PATTERN =
  /\b(it|that|this|those|same(?:\s+(?:as|one|thing|property|place))?|again|repeat|usual|like\s+(?:before|last\s+time)|as\s+before|as\s+last\s+time|previous(?:ly)?|prior\s+one)\b/i;

function needsConversationalContext(text) {
  return typeof text === 'string' && CONTEXT_REFERENCE_PATTERN.test(text);
}

export async function extractTransactionFields(text, options = {}) {
  const aiService =
    options.aiService ||
    createAIService({
      model: env.geminiParserModel,
    });

  const knownPropertyNames = Array.isArray(options.knownPropertyNames)
    ? options.knownPropertyNames
    : [];

  const userText = typeof text === 'string' ? text.trim() : '';

  let chatHistory = [];
  let recentTransactions = [];

  if (options.senderId && needsConversationalContext(userText)) {
    try {
      const [historyResult, txResult] = await Promise.all([
        getConversationContext(options.senderId),
        getRecentTransactions(options.senderId),
      ]);

      chatHistory = Array.isArray(historyResult) ? historyResult.slice(-8) : [];
      recentTransactions = Array.isArray(txResult) ? txResult.slice(-5) : [];
    } catch (ctxErr) {
      console.warn(`[AiParsingService] Could not enrich context framework for sender ${options.senderId}: ${ctxErr.message}`);
    }
  }

  const baseSystemPrompt = buildParseTransactionSystemPrompt(knownPropertyNames);
  const contextualSystemPrompt = buildContextualSystemPrompt(baseSystemPrompt, {
    chatHistory,
    recentTransactions,
  });

  return aiService.completeJson({
    system: `${contextualSystemPrompt}

CRITICAL DATE RULES:
- If the user says "today", keep transactionDate as "today".
- If the user says "tomorrow", keep transactionDate as "tomorrow".
- If the user says "yesterday", keep transactionDate as "yesterday".
- Do not force transactionDate into ISO format.
- transactionDate may be a natural language string or null.
- Never reject a natural date phrase just because it is not ISO.
- Let the normalizer convert dates later.`,
    user: userText,
    schemaHint: PARSE_TRANSACTION_SCHEMA_HINT,
  });
}

export default {
  extractTransactionFields,
};