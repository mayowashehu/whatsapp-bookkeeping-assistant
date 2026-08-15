import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProperty,
  findPropertyInSourceText,
  normalizeTransactionFields,
} from '../../ai/parsing/TransactionNormalizer.js';

const KNOWN_PROPERTIES = [
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
];

test('resolveProperty returns id when known properties use id instead of _id', () => {
  const result = resolveProperty('Flat 2', KNOWN_PROPERTIES);

  assert.equal(result.status, 'matched');
  assert.equal(result.property.id, '6a6b6b6ee11e4ffb292fde0f');
  assert.equal(result.property.name, 'Flat 2');
});

test('findPropertyInSourceText extracts a known property from transaction text', () => {
  const result = findPropertyInSourceText('Paid 15,000 for repairs at Flat 2', KNOWN_PROPERTIES);

  assert.equal(result.status, 'matched');
  assert.equal(result.property.id, '6a6b6b6ee11e4ffb292fde0f');
  assert.equal(result.property.name, 'Flat 2');
});

test('normalizeTransactionFields resolves property from source text when AI omits it', () => {
  const result = normalizeTransactionFields(
    {
      type: 'expense',
      amount: 15000,
      property: null,
      category: 'repairs',
      description: 'repairs',
      transactionDate: 'today',
    },
    {
      knownProperties: KNOWN_PROPERTIES,
      sourceText: 'Paid 15,000 for repairs at Flat 2',
      referenceDate: new Date('2026-07-31T10:00:00Z'),
    },
  );

  assert.equal(result.draft.property, '6a6b6b6ee11e4ffb292fde0f');
  assert.ok(!result.missingFields.includes('property'));
});

test('normalizeTransactionFields resolves property when AI returns the property name', () => {
  const result = normalizeTransactionFields(
    {
      type: 'expense',
      amount: 15000,
      property: 'Flat 2',
      category: 'repairs',
      description: 'repairs',
      transactionDate: 'today',
    },
    {
      knownProperties: KNOWN_PROPERTIES,
      sourceText: 'Paid 15,000 for repairs at Flat 2',
      referenceDate: new Date('2026-07-31T10:00:00Z'),
    },
  );

  assert.equal(result.draft.property, '6a6b6b6ee11e4ffb292fde0f');
  assert.ok(!result.missingFields.includes('property'));
});
