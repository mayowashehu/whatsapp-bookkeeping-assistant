import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMessage, normalizeClassification, hasTransactionSignal } from '../../ai/MessageClassifier.js';

function neverCalledAiService() {
  return {
    async completeJson() {
      throw new Error('AI should not have been called — the deterministic layer should have resolved this.');
    },
  };
}

// --- The actual bug: a real transaction containing common inquiry words ---

test('a genuine transaction containing "add"/"log"/"property" is no longer forced into GENERAL_INQUIRY, and defers to the AI classifier instead', async () => {
  const aiService = {
    async completeJson() {
      return { intent: 'LOG_ENTRY', confidence: 0.92, reasoning: 'Complete transaction description.' };
    },
  };

  const result = await classifyMessage('Paid 20k for repairs, add this to the log at Orchid property', { aiService });

  assert.equal(result.intent, 'LOG_ENTRY');
});

test('hasTransactionSignal correctly identifies the verb+amount pairing driving the fix', () => {
  assert.equal(hasTransactionSignal('paid 20k for repairs, add this to the log'), true);
  assert.equal(hasTransactionSignal('received 15k, help me with the entry'), true);
});

// --- No regression: a genuine how-to question still resolves deterministically, with zero AI calls ---

test('a genuine how-to question with no transaction signal still resolves instantly to GENERAL_INQUIRY without calling the AI', async () => {
  const result = await classifyMessage('How do I add a new property', { aiService: neverCalledAiService() });

  assert.equal(result.intent, 'GENERAL_INQUIRY');
});

test('"help me understand how this works" still resolves deterministically to GENERAL_INQUIRY', async () => {
  const result = await classifyMessage('Help me understand how this works', { aiService: neverCalledAiService() });

  assert.equal(result.intent, 'GENERAL_INQUIRY');
});

test('normalizeClassification still works normally for a genuine GENERAL_INQUIRY the AI classifier returns', () => {
  const result = normalizeClassification({ intent: 'GENERAL_INQUIRY', confidence: 0.9, reasoning: 'how-to question' });
  assert.equal(result.intent, 'GENERAL_INQUIRY');
});
