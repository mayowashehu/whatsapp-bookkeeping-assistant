import { card } from '../../utils/waFormat.js';

export function generateClarificationQuestion({ missingFields = [], propertyCandidates = [], pendingNewPropertyName = null, draft = {} }) {
  const fields = Array.isArray(missingFields) ? missingFields : [];
  if (fields.length === 0) return null;

  const currentField = fields[0];
  const type = draft?.type || 'transaction';
  let question;

  if (currentField === 'property') {
    if (Array.isArray(propertyCandidates) && propertyCandidates.length > 1) {
      const names = propertyCandidates.map(p => p.name).join(', ');
      question = `I found more than one property that could match (${names}). Which one do you mean?`;
    } else if (pendingNewPropertyName) {
      question = `Is "${pendingNewPropertyName}" a new property? Reply YES to confirm or provide an existing property name.`;
    } else {
      question = `Which property should I use for this ${type === 'income' ? 'income' : 'expense'}?`;
    }
  } else if (currentField === 'amount') {
    // Prefer a targeted, conversational phrasing once we already know the
    // type — "How much was paid?" reads as a direct follow-up to the
    // user's own words, versus the generic fallback which is only needed
    // when we genuinely don't know income vs expense yet.
    if (draft?.type === 'expense') question = 'How much was paid?';
    else if (draft?.type === 'income') question = 'How much did you receive?';
    else question = 'What amount was this? (e.g., 20,000 or 20k)';
  } else if (currentField === 'type') {
    question = 'Is this an Income or an Expense?';
  } else if (currentField === 'category') {
    question = 'What category of expense is this? (e.g., Maintenance, Utilities, Repairs)';
  } else if (currentField === 'transactionDate') {
    question = 'What date did this happen? (e.g., Today, Yesterday, or 12 Jan)';
  } else {
    question = `Could you please provide the missing ${currentField}?`;
  }

  return card('🔍', 'Quick Question', [question]);
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

  return card('✅', 'Got It', [`Set ${fieldDesc}.`], nextPrompt || null);
}

export default {
  generateClarificationQuestion,
  formatTransitionFeedback,
};