/**
 * Formats welcome and help-card replies for WhatsApp.
 */

export function formatGreetingReply() {
  return [
    '👋 *Welcome to your bookkeeping assistant.*',
    '',
    'I keep track of income and expenses across your properties, so you always know where things stand \u2014 no spreadsheets, no manual entry.',
    '',
    'Just tell me what happened, in your own words, and I\u2019ll take it from there. When you\u2019re ready, I can also pull up a statement for any property.',
  ].join('\n');
}

// NOTE (2.1): the isGreeting=false branch below used to be the reply sent
// for EVERY UNKNOWN message, unconditionally. It's now only the AI-failure
// fallback for UNKNOWN (see unKnownReply.js's getUnknownReply) — the
// primary UNKNOWN reply is AI-generated and capability-honest instead. Kept
// unchanged here on purpose: it still needs to work standalone as a safe,
// always-correct card with zero dependencies when the AI call it backs up
// has already failed.
export function formatHelpCard({ isGreeting = false } = {}) {
  if (isGreeting) {
    return formatGreetingReply();
  }

  return [
    '👋 *I didn\u2019t quite catch that \u2014 no worries, let\u2019s get you sorted.*',
    '',
    'Here\u2019s what I can help with:',
    '',
    '📝 *Log a transaction*',
    '- Type it: "Paid ₦15,000 for repairs at Flat 2"',
    '- Send a *photo* of a receipt',
    '- Send a *voice note*',
    '',
    '📊 *Check your records*',
    '- "How much rent came in this month?"',
    '- "List my properties"',
    '',
    '📄 *Generate statements*',
    '- "Generate July statement for Flat 2"',
    '',
    '✏️ *Fix something*',
    '- "Delete my last transaction"',
    '- "Change the amount to ₦20,000" (while a draft is pending)',
    '',
    '💡 Reply *YES* to save a pending transaction, or *cancel* to drop it.',
  ].join('\n');
}

// FIX (new-user first-message swallow, §1): a brand-new user's very first
// message can be a real transaction/query phrased in a way that doesn't
// match the deterministic fast-path checks (e.g. "I received 100k rent for
// Orchid" instead of "Received 100k rent for Orchid"). We still want to
// welcome them, but not at the cost of silently discarding their message —
// see the decoration logic in messageHandlerShared.js's processMessageContent.
// This `short` variant is a compact preamble meant to be prepended to
// whatever real reply the pipeline produces, instead of replacing it.
export function formatWelcomeMessage({ short = false } = {}) {
  if (short) {
    return "👋 Welcome! I'm your bookkeeping assistant. Here's what I found in your message:";
  }
  return formatGreetingReply();
}

export default {
  formatGreetingReply,
  formatHelpCard,
  formatWelcomeMessage,
};