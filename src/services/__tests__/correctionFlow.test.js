import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeterministicPatch, sanitizePatch, buildCorrectionPatch } from '../buildCorrectionPatch.js';
import { applyCorrectionPatch } from '../draft/CorrectionProcessor.js';
import { applyClarificationAnswer } from '../draft/ClarificationProcessor.js';
import { formatConfirmationMessage } from '../draft/DraftFormatter.js';

const KNOWN_PROPERTIES = [
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
];

const INCOME_DRAFT = {
  type: 'income',
  property: '6a6b6b6ee11e4ffb292fde0f',
  pendingNewPropertyName: null,
  amount: 200000,
  category: null,
  description: 'rent',
  sourceText: 'Received 200k rent for Flat 2',
  transactionDate: new Date('2026-07-31T12:00:00+01:00'),
};

test('buildDeterministicPatch extracts a property change without AI', () => {
  const patch = buildDeterministicPatch('Change the property to Orchid instead', KNOWN_PROPERTIES);

  assert.deepEqual(patch, { property: 'Orchid' });
});

test('sanitizePatch removes null and empty AI fields', () => {
  assert.deepEqual(
    sanitizePatch({ property: 'Orchid', type: null, amount: '', description: '  ' }),
    { property: 'Orchid' },
  );
});

test('applyCorrectionPatch updates only the property and keeps the rest of the draft intact', () => {
  const result = applyCorrectionPatch(
    INCOME_DRAFT,
    { property: 'Orchid' },
    { knownProperties: KNOWN_PROPERTIES, referenceDate: new Date('2026-07-31T10:00:00Z') },
  );

  assert.equal(result.clarificationRequired, false);
  assert.equal(result.draftEntry.type, 'income');
  assert.equal(result.draftEntry.amount, 200000);
  assert.equal(result.draftEntry.property, '6a63b9ca8e81f864fde888b6');
  assert.equal(result.draftEntry.pendingNewPropertyName, null);
  assert.ok(result.draftEntry.transactionDate instanceof Date);

  const reply = formatConfirmationMessage({
    type: result.draftEntry.type,
    amount: result.draftEntry.amount,
    propertyName: 'Orchid',
    transactionDate: result.draftEntry.transactionDate,
  });

  assert.equal(
    reply,
    "I've drafted an income entry of ₦200,000 for Orchid. Reply YES to save it.",
  );
});

test('applyCorrectionPatch ignores null type values from noisy AI patches', () => {
  const result = applyCorrectionPatch(
    INCOME_DRAFT,
    { property: 'Orchid', type: null, amount: null, transactionDate: null },
    { knownProperties: KNOWN_PROPERTIES, referenceDate: new Date('2026-07-31T10:00:00Z') },
  );

  assert.equal(result.clarificationRequired, false);
  assert.equal(result.draftEntry.type, 'income');
  assert.equal(result.draftEntry.amount, 200000);
  assert.equal(result.draftEntry.property, '6a63b9ca8e81f864fde888b6');
});

test('buildDeterministicPatch never treats a bare year alone as a full date — leaves it to the AI path', () => {
  const patch = buildDeterministicPatch('Edit the year to 2026', []);
  assert.deepEqual(patch, {}, 'a bare year must not short-circuit into an invalid deterministic transactionDate');
});

test('buildDeterministicPatch still resolves a full explicit date deterministically', () => {
  const patch = buildDeterministicPatch('Change the date to 12 Jan', []);
  assert.deepEqual(patch, { transactionDate: '12 Jan' });
});

// --- Fix (follow-up): partial date edits combine with the current date ---

test('buildCorrectionPatch tells the AI the current transaction date so a bare year can be combined into a full date', async () => {
  let capturedSystemPrompt = null;
  const aiService = {
    async completeJson({ system }) {
      capturedSystemPrompt = system;
      return { patch: { transactionDate: '2026-07-27' } };
    },
  };

  const result = await buildCorrectionPatch('Edit the year to 2026', {
    knownProperties: [],
    aiService,
    currentTransactionDate: new Date('2025-07-27T10:00:00Z'),
  });

  assert.match(capturedSystemPrompt, /current date is 27 Jul 2025/i);
  assert.match(capturedSystemPrompt, /combine that part with the current date/i);
  assert.deepEqual(result.patch, { transactionDate: '2026-07-27' });
});

test('buildCorrectionPatch omits the current-date guidance entirely when no date is supplied (no regression)', async () => {
  let capturedSystemPrompt = null;
  const aiService = {
    async completeJson({ system }) {
      capturedSystemPrompt = system;
      return { patch: { amount: '25000' } };
    },
  };

  await buildCorrectionPatch('Make it 25k', {
    knownProperties: [],
    aiService,
  });

  assert.doesNotMatch(capturedSystemPrompt, /current date is/i);
});

test('applyClarificationAnswer accepts natural-language dates like Today', () => {
  const result = applyClarificationAnswer(
    {
      draftEntry: {
        type: 'income',
        amount: 200000,
        property: '6a6b6b6ee11e4ffb292fde0f',
        transactionDate: null,
      },
      clarification: {
        awaiting: true,
        missingFields: ['transactionDate'],
        question: 'What date did this happen?',
      },
    },
    'Today',
    { knownProperties: KNOWN_PROPERTIES, referenceDate: new Date('2026-07-31T10:00:00Z') },
  );

  assert.equal(result.completed, true);
  assert.ok(result.draftEntry.transactionDate instanceof Date);
  assert.equal(result.draftEntry.transactionDate.toISOString().slice(0, 10), '2026-07-31');
});

test('applyClarificationAnswer skips fields that are already present on the draft', () => {
  const result = applyClarificationAnswer(
    {
      draftEntry: {
        type: 'income',
        amount: 200000,
        property: '6a6b6b6ee11e4ffb292fde0f',
        transactionDate: new Date('2026-07-31T12:00:00+01:00'),
      },
      clarification: {
        awaiting: true,
        missingFields: ['type', 'amount', 'transactionDate', 'property'],
        question: 'Is this an Income or an Expense?',
      },
    },
    'income',
    { knownProperties: KNOWN_PROPERTIES, referenceDate: new Date('2026-07-31T10:00:00Z') },
  );

  assert.equal(result.completed, true);
  assert.equal(result.draftEntry.type, 'income');
  assert.equal(result.draftEntry.amount, 200000);
});
