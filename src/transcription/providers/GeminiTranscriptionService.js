import fs from 'node:fs/promises';
import env from '../../config/env.js';
import { createAppError } from '../../utils/createAppError.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { buildVoiceTranscriptionInstruction } from '../../prompts/transcribeVoiceNote.js';

export function createGeminiTranscriptionService() {
  return {
    async transcribe({ filePath, mimeType }) {
      if (!env.geminiApiKey) throw createAppError('TRANSCRIPTION_CONFIG_ERROR', 'GEMINI_API_KEY is not configured');
      if (!filePath || !mimeType) throw createAppError('TRANSCRIPTION_INVALID_INPUT', 'filePath and mimeType are required');

      const baseMime = String(mimeType).split(';')[0].trim().toLowerCase();
      let audioBase64;

      try {
        const buffer = await fs.readFile(filePath);
        audioBase64 = buffer.toString('base64');
      } catch (err) {
        throw createAppError('TRANSCRIPTION_READ_FAILED', `Failed to read audio file: ${err.message}`, { cause: err });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`;
      const body = {
        contents: [{
          parts: [
            { inline_data: { mime_type: baseMime, data: audioBase64 } },
            { text: buildVoiceTranscriptionInstruction() },
          ],
        }],
      };

      let response;
      try {
        response = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.geminiApiKey }, body: JSON.stringify(body) }, env.transcriptionTimeoutMs);
      } catch (err) {
        if (err?.code === 'TIMEOUT') throw createAppError('TRANSCRIPTION_TIMEOUT', `Transcription timed out after ${env.transcriptionTimeoutMs}ms`, { cause: err });
        throw createAppError('TRANSCRIPTION_REQUEST_FAILED', `Transcription request failed: ${err.message}`, { cause: err });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        throw createAppError('TRANSCRIPTION_INVALID_RESPONSE', `API returned non-JSON (HTTP ${response.status})`, { cause: err });
      }

      if (!response.ok) {
        const status = response.status;
        const apiMessage = payload?.error?.message || response.statusText;

        if (status === 429) {
          throw createAppError('AI_RATE_LIMIT', `Transcription rate limit exceeded: ${apiMessage}`, { statusCode: 429 });
        }
        if (status === 404) {
          throw createAppError('AI_MODEL_NOT_FOUND', `Transcription model not found: ${apiMessage}`, { statusCode: 404 });
        }
        if (status === 400) {
          // A 400 from Gemini here almost always means the audio payload
          // itself was rejected (corrupted, empty, or an encoding it can't
          // read) rather than the provider being unavailable — surface it
          // as an audio-content problem, not a "system busy" one.
          throw createAppError('TRANSCRIPTION_BAD_AUDIO', `Transcription rejected the audio: ${apiMessage}`, { statusCode: 400 });
        }
        if (status >= 400 && status < 500) {
          throw createAppError('AI_UNAVAILABLE', `Transcription client error: ${apiMessage}`, { statusCode: status });
        }
        throw createAppError('TRANSCRIPTION_PROVIDER_ERROR', `Transcription provider error: ${apiMessage}`, { statusCode: status });
      }

      const text = payload?.candidates?.[0]?.content?.parts?.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
      if (!text) throw createAppError('TRANSCRIPTION_INVALID_RESPONSE', 'Transcription API response did not include transcript text');

      return { text, confidence: null };
    },
  };
}

export default { createGeminiTranscriptionService };
