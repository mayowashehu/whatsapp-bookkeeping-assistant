/**
 * Validates that deterministic query patterns never invoke the Gemini API.
 * Run: node src/scripts/validateDeterministicQueries.js
 */
import { interpretQuery, QUERY_TYPES } from '../services/query/QueryInterpreter.js';

const knownProperties = [
  { id: '507f1f77bcf86cd799439011', name: 'Flat 2', aliases: ['Apartment 2'] },
  { id: '507f1f77bcf86cd799439012', name: '123 Main St', aliases: [] },
];

const deterministicQueries = [
  'list my properties',
  'how much this month',
  'last 5 transactions',
  'biggest expense this month',
  'total income for Flat 2',
  'net income this month',
  'expenses by category',
  'how much for Flat 2',
];

let apiCalled = false;
const mockAiService = {
  completeJson() {
    apiCalled = true;
    throw new Error('AI should not have been called for deterministic query');
  },
};

let passed = 0;
let failed = 0;

for (const query of deterministicQueries) {
  apiCalled = false;
  const result = await interpretQuery(query, { knownProperties, aiService: mockAiService });
  if (apiCalled) {
    console.error(`FAIL: "${query}" triggered AI call`);
    failed += 1;
    continue;
  }
  if (result.source !== 'deterministic') {
    console.error(`FAIL: "${query}" source=${result.source}, expected deterministic`);
    failed += 1;
    continue;
  }
  if (result.queryType === QUERY_TYPES.UNKNOWN) {
    console.error(`FAIL: "${query}" resolved to UNKNOWN`);
    failed += 1;
    continue;
  }
  console.log(`OK: "${query}" → ${result.queryType} (${result.source})`);
  passed += 1;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
