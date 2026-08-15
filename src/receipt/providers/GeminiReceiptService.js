import fs from 'node:fs/promises';
import env from '../../config/env.js';
import { createAppError } from '../../utils/createAppError.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';

const UNREADABLE_MARKER = 'UNREADABLE';

// FIX (3.1): rather than building a parallel structured-extraction +
// normalization pipeline for photos, this deliberately mirrors what
// GeminiTranscriptionService.js already does for voice notes: turn the
// media into ONE plain-English sentence in the same style users already
// type ("Paid 15,000 for diesel at Flat 2"), then hand that sentence to
// the exact same processMessageContent() pipeline as text — see
// ReceiptMessageService.js. That gets property matching, clarification for
// missing fields, and the confirm/cancel state machine for free, with zero
// new code paths to keep in sync with the text pipeline.
export function createGeminiReceiptService() {
  return {
    async extractReceiptText({ filePath, mimeType, caption }) {
      if (!env.geminiApiKey) throw createAppError('RECEIPT_CONFIG_ERROR', 'GEMINI_API_KEY is not configured');
      if (!filePath || !mimeType) throw createAppError('RECEIPT_INVALID_INPUT', 'filePath and mimeType are required');

      const baseMime = String(mimeType).split(';')[0].trim().toLowerCase();
      let imageBase64;

      try {
        const buffer = await fs.readFile(filePath);
        imageBase64 = buffer.toString('base64');
      } catch (err) {
        throw createAppError('RECEIPT_READ_FAILED', `Failed to read receipt image: ${err.message}`, { cause: err });
      }

      // The caption is genuinely valuable signal, not just extra text: a
      // user photographing a receipt for "Flat 2" very plausibly types
      // "Flat 2" as the WhatsApp caption, which is far more reliable
      // property context than anything printed on the receipt itself.
      const trimmedCaption = caption && String(caption).trim() ? String(caption).trim() : '';
      const captionLine = trimmedCaption
        ? `\n\nThe user also sent this caption along with the photo, which may name the property or add other context: "${trimmedCaption}"`
        : '';

      const promptText = [
        'You are looking at a photo sent by a Nigerian property manager for bookkeeping.',
        'Read the total amount paid and what it was for (vendor name and/or item/service description), and any date visible, from any receipt, invoice, or proof-of-payment shown in the image.',
        captionLine,
        '',
        'Respond with ONE short plain-English sentence in this exact style: "Paid <amount> for <item/vendor description>[ at <property, only if the caption clearly names one>][ on <date, only if actually visible on the receipt>]".',
        'Use the naira amount as plain digits with no currency symbol (e.g. 4500, not \u20a64500 or $4500).',
        'Only include the date clause if a date is genuinely visible on the receipt \u2014 never invent one.',
        'Only include the property clause if the caption clearly names a property.',
        '',
        `If the image is NOT a receipt, invoice, or proof of payment, or if you cannot confidently read a total amount, respond with EXACTLY the single word: ${UNREADABLE_MARKER}.`,
        'Do not guess an amount you are not reasonably confident about \u2014 a wrong amount is worse than asking the user to type it manually.',
      ].join('\n');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`;
      const body = {
        contents: [{
          parts: [
            { inline_data: { mime_type: baseMime, data: imageBase64 } },
            { text: promptText },
          ],
        }],
      };

      let response;
      try {
        response = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey }, body: JSON.stringify(body) }, env.receiptTimeoutMs);
      } catch (err) {
        if (err?.code === 'TIMEOUT') throw createAppError('RECEIPT_TIMEOUT', `Receipt reading timed out after ${env.receiptTimeoutMs}ms`, { cause: err });
        throw createAppError('RECEIPT_REQUEST_FAILED', `Receipt reading request failed: ${err.message}`, { cause: err });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        throw createAppError('RECEIPT_INVALID_RESPONSE', `API returned non-JSON (HTTP ${response.status})`, { cause: err });
      }

      if (!response.ok) {
        const status = response.status;
        const apiMessage = payload?.error?.message || response.statusText;

        if (status === 429) {
          throw createAppError('AI_RATE_LIMIT', `Receipt reading rate limit exceeded: ${apiMessage}`, { statusCode: 429 });
        }
        if (status === 404) {
          throw createAppError('AI_MODEL_NOT_FOUND', `Receipt reading model not found: ${apiMessage}`, { statusCode: 404 });
        }
        if (status === 400) {
          // Same reasoning as GeminiTranscriptionService's audio case: a
          // 400 here almost always means the image itself was rejected
          // (corrupted, empty, or an encoding it can't read), not that the
          // provider is unavailable.
          throw createAppError('RECEIPT_BAD_IMAGE', `Receipt reading rejected the image: ${apiMessage}`, { statusCode: 400 });
        }
        if (status >= 400 && status < 500) {
          throw createAppError('AI_UNAVAILABLE', `Receipt reading client error: ${apiMessage}`, { statusCode: status });
        }
        throw createAppError('RECEIPT_PROVIDER_ERROR', `Receipt reading provider error: ${apiMessage}`, { statusCode: status });
      }

      const text = payload?.candidates?.[0]?.content?.parts?.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
      if (!text) throw createAppError('RECEIPT_INVALID_RESPONSE', 'Receipt reading API response did not include any text');

      if (text.toUpperCase() === UNREADABLE_MARKER) {
        return { text: null, unreadable: true };
      }

      return { text, unreadable: false };
    },
  };
}

export default { createGeminiReceiptService };