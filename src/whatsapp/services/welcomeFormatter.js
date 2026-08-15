/**
 * Formats welcome and help-card replies for WhatsApp.
 */

export function formatGreetingReply() {
  return [
    '👋 Hello! I\'m here to help with your bookkeeping.',
    '',
    'Send a transaction like: *Paid 15,000 for repairs at Flat 2*',
    'Or ask for a report like: *Monthly statement for Flat 2*',
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
    '⚠️ *I didn\'t quite understand that.*',
    '',
    'Here are a few things you can ask me to do:',
    '',
    '📝 *Log income or expenses*',
    '- "Paid ₦15,000 for repairs at Flat 2"',
    '- "Received ₦200,000 rent for Flat 2"',
    '',
    '📊 *Check your records*',
    '- "How much rent came in this month?"',
    '- "Total repairs this year"',
    '- "List my properties"',
    '',
    '📄 *Generate statements*',
    '- "Generate July statement for Flat 2"',
    '',
    '💡 *Tips*',
    '- Reply *YES* to save a pending transaction.',
    '- Say *cancel* if you don\'t want to save it.',
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