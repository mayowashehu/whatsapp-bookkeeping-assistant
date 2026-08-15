/**
 * Validates Gemini API connectivity with the configured model.
 * Run: node src/scripts/validateGeminiApi.js
 */
import dotenv from 'dotenv';
import { getGeminiModel } from '../services/ai/geminiClient.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const model = getGeminiModel();

if (!apiKey) {
  console.error('FAIL: GEMINI_API_KEY is not set in .env');
  process.exit(1);
}

const url =
  `https://generativelanguage.googleapis.com/v1beta/models/` +
  `${encodeURIComponent(model)}:generateContent`;

const body = {
  contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
  generationConfig: { temperature: 0 },
};

console.log(`Testing Gemini model: ${model}`);

const response = await fetchWithTimeout(
  url,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  },
  30000,
);

const payload = await response.json();

if (!response.ok) {
  console.error(`FAIL: HTTP ${response.status}`);
  console.error(JSON.stringify(payload?.error || payload, null, 2));
  process.exit(1);
}

const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
console.log(`OK: HTTP ${response.status} — model responded: "${text || '(empty)'}"`);
process.exit(0);
