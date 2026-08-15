import test from 'node:test';
import assert from 'node:assert/strict';

import { applyClarificationAnswer } from '../draft/ClarificationProcessor.js';

const KNOWN_PROPERTIES = [
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
];

test('applyClarificationAnswer stores matched property id for a known property name', () => {
  const result = applyClarificationAnswer(
    {
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
    },
    'Flat 2',
    { knownProperties: KNOWN_PROPERTIES },
  );

  assert.equal(result.completed, true);
  assert.equal(result.draftEntry.property, '6a6b6b6ee11e4ffb292fde0f');
  assert.equal(result.draftEntry.pendingNewPropertyName, null);
});
