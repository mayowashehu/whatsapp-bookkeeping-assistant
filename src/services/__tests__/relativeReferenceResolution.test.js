import test from 'node:test';
import assert from 'node:assert/strict';

import { applyClarificationAnswer } from '../draft/ClarificationProcessor.js';
import { buildParseTransactionSystemPrompt, PARSE_TRANSACTION_SCHEMA_HINT } from '../../prompts/parseTransaction.js';

const KNOWN_PROPERTIES = [
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
];

function draftAwaitingProperty() {
  return {
    draftEntry: {
      type: 'expense',
      amount: 15000,
      category: 'repairs',
      property: null,
      pendingNewPropertyName: null,
      transactionDate: new Date('2026-07-31T12:00:00+01:00'),
    },
    clarification: {
      awaiting: true,
      missingFields: ['property'],
      question: 'Which property should I use for this expense?',
    },
  };
}

// --- ClarificationProcessor.js: "never guess" guard on relative-reference answers ---

const RELATIVE_REFERENCE_ANSWERS = [
  'same as yesterday',
  'same one',
  'same property',
  'the same',
  'the usual',
  'the usual place',
  'as before',
  'like last time',
  'again',
  'previous one',
  'that one',
  'the last one',
];

for (const answer of RELATIVE_REFERENCE_ANSWERS) {
  test(`applyClarificationAnswer never guesses a property from a bare relative reference: "${answer}"`, () => {
    const result = applyClarificationAnswer(draftAwaitingProperty(), answer, { knownProperties: KNOWN_PROPERTIES });

    assert.equal(result.completed, false);
    assert.ok(result.error, 'must ask again instead of silently creating a new property');
    assert.doesNotMatch(result.error, new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  });
}

test('applyClarificationAnswer still resolves a real property name normally (guard is not over-broad)', () => {
  const result = applyClarificationAnswer(draftAwaitingProperty(), 'Orchid', { knownProperties: KNOWN_PROPERTIES });

  assert.equal(result.completed, true);
  assert.equal(result.draftEntry.property, '6a63b9ca8e81f864fde888b6');
});

test('applyClarificationAnswer still resolves a conversational reply naming a real property ("it\'s for Flat 2")', () => {
  const result = applyClarificationAnswer(draftAwaitingProperty(), "it's for Flat 2", { knownProperties: KNOWN_PROPERTIES });

  assert.equal(result.completed, true);
  assert.equal(result.draftEntry.property, '6a6b6b6ee11e4ffb292fde0f');
});

test('applyClarificationAnswer still creates a genuinely new property name that merely contains "same"-adjacent words is not falsely blocked', () => {
  // Sanity check the guard is anchored to the WHOLE answer, not a substring
  // match — a real (if oddly named) property called "Sameer Court" must
  // still go through as a new-property candidate, not get blocked.
  const result = applyClarificationAnswer(draftAwaitingProperty(), 'Sameer Court', { knownProperties: KNOWN_PROPERTIES });

  assert.equal(result.completed, true);
  assert.equal(result.draftEntry.pendingNewPropertyName, 'Sameer Court');
});

// --- parseTransaction.js: relative-reference resolution prompt guidance ---

test('parseTransaction system prompt instructs the model to resolve relative references only when unambiguous', () => {
  const prompt = buildParseTransactionSystemPrompt(['Orchid', 'Flat 2']);

  assert.match(prompt, /RELATIVE-REFERENCE RESOLUTION/);
  assert.match(prompt, /exactly ONE transaction/i);
  assert.match(prompt, /NEVER guess/i);
});

test('parseTransaction system prompt and schema hint both carry a confidence field (Phase 6.3 groundwork)', () => {
  const prompt = buildParseTransactionSystemPrompt(['Orchid']);
  assert.match(prompt, /"confidence"/);
  assert.match(PARSE_TRANSACTION_SCHEMA_HINT, /"confidence"/);
});
