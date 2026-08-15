import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTransactionFields } from '../../ai/parsing/TransactionNormalizer.js';
import { mapParserDraftToDraftEntry } from '../draft/draftMapper.js';
import { buildCorrectionPatch } from '../buildCorrectionPatch.js';

test('normalizeTransactionFields preserves an explicit property without asking for it again', () => {
  const result = normalizeTransactionFields(
    {
      type: 'expense',
      amount: '50k',
      property: 'Orchid Apartment',
      category: 'utilities',
      description: 'Electricity bills',
      transactionDate: 'today',
    },
    {
      knownProperties: [],
      sourceText: 'I just paid 50k for electricity bills at orchid apartment',
      referenceDate: new Date('2026-07-27T10:00:00Z'),
    },
  );

  assert.equal(result.draft.amount, 50000);
  assert.equal(result.draft.pendingNewPropertyName, 'Orchid Apartment');
  assert.ok(!result.missingFields.includes('property'));
  assert.ok(!result.missingFields.includes('amount'));
});

test('mapParserDraftToDraftEntry parses natural dates like yesterday into a corrected Date', () => {
  const mapped = mapParserDraftToDraftEntry({ transactionDate: 'yesterday' });
  const expected = new Date();
  expected.setDate(expected.getDate() - 1);
  expected.setHours(12, 0, 0, 0);

  assert.ok(mapped.transactionDate instanceof Date);
  assert.equal(mapped.transactionDate.toDateString(), expected.toDateString());
});

test('buildCorrectionPatch uses AI extraction to turn conversational edits into a patch', async () => {
  const aiService = {
    async completeJson({ user }) {
      assert.match(user, /edit the year to 2026/i);
      return {
        patch: {
          transactionDate: '2026-07-27',
        },
      };
    },
  };

  const result = await buildCorrectionPatch('Edit the year to 2026', {
    knownProperties: [],
    aiService,
  });

  assert.deepEqual(result.patch, { transactionDate: '2026-07-27' });
});
