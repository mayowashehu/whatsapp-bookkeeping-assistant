

/**
 * Factory — the only place that selects a concrete transcription provider.
 * Callers receive a TranscriptionService contract implementation and must
 * never import provider modules directly.
 *
 * v0.1 uses Gemini exclusively. Future providers can be switched here
 * (e.g. via an env flag) without changing VoiceMessageService or routers.
 *
 * @returns {import('./TranscriptionService.js').TranscriptionService}
 */
import { createGeminiTranscriptionService } from './providers/GeminiTranscriptionService.js';

export function createTranscriptionService() {
  return createGeminiTranscriptionService();
}

export default { createTranscriptionService };
