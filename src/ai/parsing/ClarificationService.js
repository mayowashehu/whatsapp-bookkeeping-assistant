export function generateClarificationQuestion({ missingFields = [], propertyCandidates = [], pendingNewPropertyName = null, draft = {} }) {
  const fields = Array.isArray(missingFields) ? missingFields : [];
  if (fields.length === 0) return null;

  const currentField = fields[0];
  const type = draft?.type || 'transaction';

  if (currentField === 'property') {
    if (Array.isArray(propertyCandidates) && propertyCandidates.length > 1) {
      const names = propertyCandidates.map(p => p.name).join(', ');
      return `I found more than one property that could match (${names}). Which one do you mean?`;
    }
    if (pendingNewPropertyName) {
      return `Is "${pendingNewPropertyName}" a new property? Reply YES to confirm or provide an existing property name.`;
    }
    return `Which property should I use for this ${type === 'income' ? 'income' : 'expense'}?`;
  }

  if (currentField === 'amount') {
    // Prefer a targeted, conversational phrasing once we already know the
    // type — "How much was paid?" reads as a direct follow-up to the
    // user's own words, versus the generic fallback which is only needed
    // when we genuinely don't know income vs expense yet.
    if (draft?.type === 'expense') return 'How much was paid?';
    if (draft?.type === 'income') return 'How much did you receive?';
    return 'What amount was this? (e.g., 20,000 or 20k)';
  }

  if (currentField === 'type') {
    return 'Is this an Income or an Expense?';
  }

  if (currentField === 'category') {
    return 'What category of expense is this? (e.g., Maintenance, Utilities, Repairs)';
  }

  if (currentField === 'transactionDate') {
    return 'What date did this happen? (e.g., Today, Yesterday, or 12 Jan)';
  }

  return `Could you please provide the missing ${currentField}?`;
}

export function formatTransitionFeedback({ resolvedField, resolvedValue, nextField }) {
  let fieldDesc = resolvedField;
  if (resolvedField === 'property') fieldDesc = `the property to ${resolvedValue}`;
  else if (resolvedField === 'amount') fieldDesc = `the amount to ${resolvedValue}`;
  else if (resolvedField === 'type') fieldDesc = `the type to ${resolvedValue}`;
  else fieldDesc = `${resolvedField} to ${resolvedValue}`;

  let nextPrompt = '';
  if (nextField === 'amount') nextPrompt = 'What amount was this?';
  else if (nextField === 'property') nextPrompt = 'Which property should I use?';
  else if (nextField === 'category') nextPrompt = 'What category of expense is this?';
  else if (nextField === 'transactionDate') nextPrompt = 'What date did this happen?';

  return `Thanks — I’ve set ${fieldDesc}. ${nextPrompt}`;
}

export default {
  generateClarificationQuestion,
  formatTransitionFeedback,
};