import { formatHelpCard } from './welcomeFormatter.js';
import { createAIService } from '../../ai/createAIService.js';
import { buildInquirySystemPrompt } from '../../prompts/contextPromptBuilder.js';

// Static, deterministic reply — was previously the ONLY thing UNKNOWN ever
// sent, regardless of what the user actually typed. Now demoted to a safety
// net: it's what gets sent if the AI call in getUnknownReply below fails for
// any reason (rate limit, timeout, malformed JSON, provider outage), so an
// unclear message is never left completely unanswered. Also still used
// as-is for the GREETING case elsewhere (formatHelpCard({ isGreeting: true })
// in messageHandlerShared.js), which is unrelated to this file.
export const UNKNOWN_WHATSAPP_REPLY = formatHelpCard({ isGreeting: false });

// FIX (2.1): UNKNOWN used to always return UNKNOWN_WHATSAPP_REPLY verbatim —
// a static generic card with zero regard for what the user actually typed
// or what the app can actually do. Reuses the exact AI-backed pattern
// already proven correct for GENERAL_INQUIRY in messageHandlerShared.js
// (same buildInquirySystemPrompt + completeJson contract) rather than
// duplicating that call site a third time, with `unclear: true` so the
// prompt's additional UNCLEAR_MESSAGE_RULES section kicks in (see
// contextPromptBuilder.js) instead of the how-to-question framing used for
// GENERAL_INQUIRY. On any AI failure — including a mid-air rate limit that
// slipped past the earlier classifyMessage call — falls straight back to
// the static help card so the user is never left hanging.
export async function getUnknownReply(text, { chatHistory = [], recentTransactions = [] } = {}) {
  try {
    const aiService = createAIService();
    const systemPrompt = buildInquirySystemPrompt({ chatHistory, recentTransactions, unclear: true });
    const result = await aiService.completeJson({
      system: systemPrompt,
      user: text,
      schemaHint: '{ "reply": "string" }',
    });

    return typeof result?.reply === 'string' && result.reply.trim()
      ? result.reply
      : UNKNOWN_WHATSAPP_REPLY;
  } catch (err) {
    console.error('[DEBUG] Error generating AI-backed UNKNOWN reply, falling back to static help card:', err);
    return UNKNOWN_WHATSAPP_REPLY;
  }
}

export default {
  UNKNOWN_WHATSAPP_REPLY,
  getUnknownReply,
};