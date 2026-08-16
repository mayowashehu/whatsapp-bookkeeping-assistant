// Shared WhatsApp message-formatting helpers.
//
// WhatsApp only understands a handful of markdown-like tokens — *bold*,
// _italic_, ~strike~ and monospace. Every outbound reply in this app is
// built by hand from template strings, which meant the "shape" of a
// message (header vs. body vs. footer, when to use a card vs. a plain
// sentence, which emoji means what) drifted file to file. These helpers
// give every formatter in the codebase the same small vocabulary so a
// "Saved" card looks and feels like every other card, not like whatever
// the author of that one function happened to type.
//
// Nothing here talks to the network or WhatsApp's API — it only builds
// strings. Keep it that way so it stays trivially testable/reusable.

/** Bold a value the WhatsApp way: *text* */
export function bold(text) {
  return `*${text}*`;
}

/** Italicize a value the WhatsApp way: _text_ */
export function italic(text) {
  return `_${text}_`;
}

/** A card header: emoji + bold title, e.g. "✅ *Saved*" */
export function heading(emoji, title) {
  return emoji ? `${emoji} ${bold(title)}` : bold(title);
}

/** One "*Label:* value" row. Returns null (not a blank string) when value is empty so callers can .filter(Boolean) it out cleanly. */
export function row(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return `${bold(`${label}:`)} ${value}`;
}

/** One bullet row using a consistent WhatsApp-friendly bullet character. */
export function bullet(text) {
  return `• ${text}`;
}

/**
 * Assemble a full "card": a bold heading, a blank line, a body (array of
 * lines — falsy entries are dropped automatically so callers can build
 * rows conditionally without manual filtering), and an optional italic
 * footer note separated by another blank line.
 *
 * card('✅', 'Saved', [row('Amount', '₦1,000')], 'Reply YES to confirm')
 *   → "✅ *Saved*\n\n*Amount:* ₦1,000\n\n_Reply YES to confirm_"
 */
export function card(emoji, title, bodyLines = [], footer = null) {
  const body = (bodyLines || []).filter((line) => line !== null && line !== undefined && line !== '');
  const parts = [heading(emoji, title)];
  if (body.length) {
    parts.push('', body.join('\n'));
  }
  if (footer) {
    parts.push('', italic(footer));
  }
  return parts.join('\n');
}

export default { bold, italic, heading, row, bullet, card };
