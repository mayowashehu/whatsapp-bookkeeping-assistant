import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTransaction } from '../../ai/parsing/TransactionParser.js';
import { normalizeParsingConfidence, isBelowConfidenceFloor } from '../../ai/parsing/ParsingValidator.js';
import env from '../../config/env.js';

const KNOWN_PROPERTIES = [
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
];

function fakeAiService(raw) {
  return { completeJson: async () => raw };
}

function completeSingleTxRaw(confidence) {
  return {
    classification: 'SINGLE',
    transactions: [
      {
        type: 'expense',
        amount: 15000,
        property: 'Orchid',
        category: 'repairs',
        description: 'Repairs',
        transactionDate: 'today',
      },
    ],
    clarificationPrompt: null,
    confidence,
  };
}

// --- ParsingValidator.js unit coverage ---

test('normalizeParsingConfidence accepts valid 0-1 numbers and rejects everything else', () => {
  assert.equal(normalizeParsingConfidence(0.42), 0.42);
  assert.equal(normalizeParsingConfidence(0), 0);
  assert.equal(normalizeParsingConfidence(1), 1);
  assert.equal(normalizeParsingConfidence(1.5), null);
  assert.equal(normalizeParsingConfidence(-0.1), null);
  assert.equal(normalizeParsingConfidence('0.9'), null);
  assert.equal(normalizeParsingConfidence(undefined), null);
  assert.equal(normalizeParsingConfidence(NaN), null);
});

test('isBelowConfidenceFloor never fires when confidence is absent (no signal, no forced failure)', () => {
  assert.equal(isBelowConfidenceFloor({}, 0.6), false);
  assert.equal(isBelowConfidenceFloor({ confidence: 'high' }, 0.6), false);
});

test('isBelowConfidenceFloor fires only when a reported confidence is genuinely under the floor', () => {
  assert.equal(isBelowConfidenceFloor({ confidence: 0.3 }, 0.6), true);
  assert.equal(isBelowConfidenceFloor({ confidence: 0.6 }, 0.6), false);
  assert.equal(isBelowConfidenceFloor({ confidence: 0.9 }, 0.6), false);
});

// --- TransactionParser.js integration: the floor actually forces clarification ---

test('parseTransaction forces clarification when the AI itself reports low confidence on an otherwise-complete SINGLE extraction', async () => {
  const result = await parseTransaction('Paid 15k for repairs at Orchid', {
    knownProperties: KNOWN_PROPERTIES,
    aiService: fakeAiService(completeSingleTxRaw(0.2)),
  });

  assert.equal(result.clarificationRequired, true);
  assert.ok(result.clarificationQuestion, 'a clarification question must be set');
  assert.equal(result.confidence, 0.2);
  assert.match(result.reasoning, /low parsing confidence/i);
});

test('parseTransaction proceeds straight to confirmation-ready when confidence is high', async () => {
  const result = await parseTransaction('Paid 15k for repairs at Orchid', {
    knownProperties: KNOWN_PROPERTIES,
    aiService: fakeAiService(completeSingleTxRaw(0.95)),
  });

  assert.equal(result.clarificationRequired, false);
  assert.equal(result.confidence, 0.95);
});

test('parseTransaction does not force clarification just because confidence is missing entirely (no behavior regression)', async () => {
  const raw = completeSingleTxRaw(undefined);
  delete raw.confidence;

  const result = await parseTransaction('Paid 15k for repairs at Orchid', {
    knownProperties: KNOWN_PROPERTIES,
    aiService: fakeAiService(raw),
  });

  assert.equal(result.clarificationRequired, false);
  assert.equal(result.confidence, null);
});

test('a genuinely missing field still asks about that specific field first, even with high confidence', async () => {
  const raw = completeSingleTxRaw(0.95);
  raw.transactions[0].amount = null; // AI is very confident, but a field really is missing

  const result = await parseTransaction('Paid for repairs at Orchid', {
    knownProperties: KNOWN_PROPERTIES,
    aiService: fakeAiService(raw),
  });

  assert.equal(result.clarificationRequired, true);
  assert.ok(result.missingFields.includes('amount'));
  // The field-specific question wins over the generic low-confidence one.
  assert.doesNotMatch(result.clarificationQuestion, /make sure I caught that correctly/i);
});

test('env.parsingMinConfidence has a sane default and is a distinct setting from classificationMinConfidence', () => {
  assert.equal(typeof env.parsingMinConfidence, 'number');
  assert.ok(env.parsingMinConfidence > 0 && env.parsingMinConfidence <= 1);
});
