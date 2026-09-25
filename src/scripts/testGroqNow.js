/**
 * Runs YOUR real classifier + transaction-parser prompts through Groq and Gemini
 * side by side, so you can see (a) that Groq works on your key, (b) how fast it is,
 * and (c) exactly where its answers differ from Gemini's.
 *
 *   node -r dotenv/config src/scripts/testGroqNow.js
 *   node -r dotenv/config src/scripts/testGroqNow.js "Paid 15k for diesel at Flat 2" "hello boss"
 *
 * Needs GROQ_API_KEY (and GEMINI_API_KEY for the comparison column). No deploy needed,
 * no database, and it never touches your live bot or WhatsApp.
 */
import { createGroqAIService, isGroqConfigured } from '../ai/providers/GroqAIService.js';
import { createGeminiAIService } from '../ai/providers/GeminiAIService.js';
import { getGeminiApiKeys } from '../services/ai/geminiClient.js';
import { CLASSIFY_MESSAGE_SYSTEM_PROMPT, CLASSIFY_MESSAGE_SCHEMA_HINT } from '../prompts/classifyMessage.js';
import { buildParseTransactionSystemPrompt, PARSE_TRANSACTION_SCHEMA_HINT } from '../prompts/parseTransaction.js';

if (!isGroqConfigured()) {
  console.error('GROQ_API_KEY is not set. Add it to .env (or export it) and run again.');
  process.exit(1);
}

const samples = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Paid 15k for diesel at Flat 2',
      'Collected rent 200k Orchid',
      'so how many things have I logged today boss?',
      'Paid the plumber for the tap fix',
      'hello boss',
    ];

const groq = createGroqAIService();
const gemini = getGeminiApiKeys().length ? createGeminiAIService() : null;
const KNOWN_PROPERTIES = ['Flat 2', 'Orchid'];

async function timed(svc, input) {
  const t0 = Date.now();
  try {
    return { out: await svc.completeJson(input), ms: Date.now() - t0 };
  } catch (err) {
    return { err: `${err.code || 'ERROR'}: ${err.message}`, ms: Date.now() - t0 };
  }
}

const show = (label, r, pick) =>
  console.log(`  ${label.padEnd(7)} ${String(r.ms).padStart(5)}ms  ${r.err ? `FAILED -> ${r.err}` : pick(r.out)}`);

const VALID_INTENTS = ['LOG_ENTRY', 'QUERY', 'CONFIRMATION', 'CORRECTION', 'STATEMENT_REQUEST', 'GENERAL_INQUIRY', 'AFFIRMATION', 'GREETING', 'UNKNOWN'];
const intentOf = (raw) => String(raw?.intent || '').trim().toUpperCase();
const classifyLine = (raw) => {
  const intent = intentOf(raw);
  const ok = VALID_INTENTS.includes(intent);
  const conf = raw?.confidence;
  // Your app turns an unknown intent, a non-numeric confidence, or confidence < 0.7 into UNKNOWN.
  const wouldPass = ok && typeof conf === 'number' && (intent === 'UNKNOWN' || conf >= 0.7);
  return `intent=${intent || '(missing)'}  confidence=${JSON.stringify(conf)}${wouldPass ? '' : '   <-- your app would treat this as UNKNOWN'}`;
};
const parseLine = (raw) => {
  const t = raw?.transactions?.[0] || {};
  return `type=${t.type} amount=${JSON.stringify(t.amount)} property=${JSON.stringify(t.property)} category=${JSON.stringify(t.category)} date=${JSON.stringify(t.transactionDate)} clarify=${JSON.stringify(raw?.clarificationPrompt)}`;
};

for (const text of samples) {
  console.log(`\n"${text}"`);

  const classifyInput = { system: CLASSIFY_MESSAGE_SYSTEM_PROMPT, user: text, schemaHint: CLASSIFY_MESSAGE_SCHEMA_HINT };
  const g = await timed(groq, classifyInput);
  const m = gemini ? await timed(gemini, classifyInput) : null;
  console.log(' classify:');
  show('groq', g, classifyLine);
  if (m) show('gemini', m, classifyLine);
  if (m && !g.err && !m.err) {
    const same = intentOf(g.out) === intentOf(m.out);
    console.log(`  -> ${same ? 'SAME intent' : 'DIFFERENT intent  <-- look at this one'}`);
  }

  const isLog = !g.err && intentOf(g.out) === 'LOG_ENTRY';
  if (isLog) {
    const parseInput = {
      system: buildParseTransactionSystemPrompt(KNOWN_PROPERTIES),
      user: text,
      schemaHint: PARSE_TRANSACTION_SCHEMA_HINT,
    };
    const pg = await timed(groq, parseInput);
    const pm = gemini ? await timed(gemini, parseInput) : null;
    console.log(' parse:');
    show('groq', pg, parseLine);
    if (pm) show('gemini', pm, parseLine);
  }
}
console.log('\nDone. "intent" is what routes the message; category/date wording can differ harmlessly, amount/property/type should match.');
