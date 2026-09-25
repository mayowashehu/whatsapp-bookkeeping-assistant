/**
 * Shows which AI models actually answer for YOUR keys right now, and how fast.
 * Run it before/after deploys, and whenever "Assistant Busy" shows up.
 *
 *   node -r dotenv/config src/scripts/probeAiProviders.js
 *   node -r dotenv/config src/scripts/probeAiProviders.js --list      # also list Gemini flash models your key can see
 *
 * Reading the output
 *   OK  <ms>        usable. If latency is often close to AI_TIMEOUT_MS, raise it.
 *   HTTP 429        quota on THAT model for THAT project (Gemini limits are per project, per model).
 *                   "[DAILY quota]" means it won't clear for hours.
 *   HTTP 503/TIMEOUT Provider-side capacity. Not your quota, not your key.
 *   HTTP 404        model not available to you. Remove it from the list.
 *
 * Run it 2-3 times a minute apart: a model that is fast once and TIMEOUT the
 * next time is exactly the pattern behind "Assistant Busy".
 */
import { getGeminiApiKeys, getGeminiClassifierModel, CURATED_FALLBACK_MODELS } from '../services/ai/geminiClient.js';
import { getGroqModels, isGroqConfigured } from '../ai/providers/GroqAIService.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

const TIMEOUT_MS = 20000;
const wantList = process.argv.includes('--list');

function line(status, ms, name, extra = '') {
  console.log(`${status.padEnd(16)} ${String(ms).padStart(6)}ms  ${name}${extra ? `\n${' '.repeat(25)}${extra}` : ''}`);
}

async function probe(name, run) {
  const t0 = Date.now();
  try {
    const res = await run();
    const ms = Date.now() - t0;
    if (res.ok) return line('OK', ms, name);
    const body = await res.json().catch(() => ({}));
    const daily = /PerDay/i.test(JSON.stringify(body?.error || {})) ? ' [DAILY quota]' : '';
    line(`HTTP ${res.status}${daily}`, ms, name, String(body?.error?.message || res.statusText || '').slice(0, 110));
  } catch (err) {
    line(err?.code === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', Date.now() - t0, name, err?.code === 'TIMEOUT' ? '' : err.message);
  }
}

// ---- Gemini
const keys = getGeminiApiKeys();
if (!keys.length) {
  console.log('Gemini: no GEMINI_API_KEY set.\n');
} else {
  const models = [...new Set([getGeminiClassifierModel(), ...CURATED_FALLBACK_MODELS])];
  console.log(`GEMINI  (${keys.length} key(s) configured — probing with the first)\n`);
  if (wantList) {
    const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': keys[0] } }, TIMEOUT_MS);
    const body = await res.json().catch(() => ({}));
    const names = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /flash|lite/i.test(n));
    console.log('Flash-class models visible to this key:\n  ' + (names.join('\n  ') || '(none / list failed)') + '\n');
  }
  for (const model of models) {
    await probe(model, () =>
      fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[0] },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Return JSON: {"ok": true}' }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
          }),
        },
        TIMEOUT_MS,
      ),
    );
  }
}

// ---- Groq
console.log('\nGROQ');
if (!isGroqConfigured()) {
  console.log('  GROQ_API_KEY not set -> Groq fallback is OFF (Gemini-only).');
} else {
  console.log('');
  for (const model of getGroqModels()) {
    await probe(model, () =>
      fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: 'Return a JSON object: {"ok": true}' }],
          }),
        },
        TIMEOUT_MS,
      ),
    );
  }
}
