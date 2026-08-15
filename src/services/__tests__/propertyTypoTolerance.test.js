import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProperty, damerauLevenshteinDistance } from '../../ai/parsing/TransactionNormalizer.js';

const KNOWN_PROPERTIES = [
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
  { id: '6a63b9ca8e81f864fde888c7', name: 'Flat 3', aliases: [], active: true },
  { id: '6a63b9ca8e81f864fde888d8', name: 'Greenview Estate', aliases: ['Greenview'], active: true },
];

// --- damerauLevenshteinDistance: sanity check the primitive itself ---

test('damerauLevenshteinDistance treats an adjacent transposition as a single edit', () => {
  assert.equal(damerauLevenshteinDistance('orhcid', 'orchid'), 1);
});

test('damerauLevenshteinDistance counts a genuine substitution correctly', () => {
  assert.equal(damerauLevenshteinDistance('orchid', 'orchit'), 1);
});

test('damerauLevenshteinDistance returns 0 for identical strings', () => {
  assert.equal(damerauLevenshteinDistance('orchid', 'orchid'), 0);
});

// --- resolveProperty: typos of an existing property should resolve to it ---

test('resolveProperty corrects a transposed-letter typo to the real property', () => {
  const result = resolveProperty('Orhcid', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Orchid');
});

test('resolveProperty corrects a single dropped letter', () => {
  const result = resolveProperty('Orchd', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Orchid');
});

test('resolveProperty corrects a single substituted letter', () => {
  const result = resolveProperty('Orchit', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Orchid');
});

test('resolveProperty corrects a typo against a multi-word property name', () => {
  const result = resolveProperty('Greenviw Estate', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Greenview Estate');
});

test('resolveProperty corrects a typo against an alias, not just the primary name', () => {
  const result = resolveProperty('Greenviw', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Greenview Estate');
});

// --- Safety: must NEVER bridge a genuine digit difference ---

test('resolveProperty never treats "Flat 2" and "Flat 3" as typos of each other', () => {
  const result = resolveProperty('Flat 3', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Flat 3');
  assert.notEqual(result.property.name, 'Flat 2');
});

test('resolveProperty still resolves an exact match normally without invoking fuzzy logic', () => {
  const result = resolveProperty('Flat 2', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Flat 2');
});

test('a typo of "Flat 2" (letters only, digit intact) still resolves to Flat 2, not Flat 3', () => {
  const result = resolveProperty('Flta 2', KNOWN_PROPERTIES);
  assert.equal(result.status, 'matched');
  assert.equal(result.property.name, 'Flat 2');
});

// --- Safety: never guess on a genuine tie ---

test('resolveProperty reports ambiguous (never guesses) when two properties tie for closest fuzzy match', () => {
  const tiedProperties = [
    { id: 'a1', name: 'Bexey', aliases: [], active: true }, // "Bexley" minus the "l" — distance 1
    { id: 'a2', name: 'Bexly', aliases: [], active: true }, // "Bexley" minus the second "e" — distance 1
  ];
  const result = resolveProperty('Bexley', tiedProperties);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

// --- Safety: short/unrelated input must not fuzzy-match nonsense ---

test('resolveProperty does not fuzzy-match a very short, unrelated mention', () => {
  const result = resolveProperty('Or', KNOWN_PROPERTIES);
  assert.equal(result.status, 'none');
});

test('resolveProperty does not fuzzy-match a genuinely unrelated new property name', () => {
  const result = resolveProperty('Sunset Villa', KNOWN_PROPERTIES);
  assert.equal(result.status, 'none');
});

test('resolveProperty leaves a real, different, deliberately-named new property alone (not swallowed as a typo)', () => {
  // "Flat 25" is nowhere near "Flat 2" or "Flat 3" once digits are
  // compared as a whole ("25" vs "2"/"3"), so this must not resolve at all.
  const result = resolveProperty('Flat 25', KNOWN_PROPERTIES);
  assert.equal(result.status, 'none');
});
