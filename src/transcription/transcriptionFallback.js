/**
 * Fallback messaging for voice-note specific failures — missing media,
 * unsupported/corrupted audio, and transcription failures.
 *
 * This is deliberately kept separate from ai/aiFallback.js:
 *
 * - ai/aiFallback.js answers "is the AI provider temporarily unavailable?"
 *   (rate limited, model missing, provider overloaded) — the fix is to wait
 *   and retry the exact same message.
 * - This module answers "is something wrong with the audio itself?"
 *   (corrupted file, unsupported format, too long to transcribe within the
 *   timeout budget) — the fix is to send a different/shorter recording, or
 *   just type the transaction as text. Retrying the same file will not help.
 *
 * Keeping these separate means the user gets guidance that actually matches
 * what went wrong, instead of one generic "something went wrong" message.
 */

export const AUDIO_PROCESSING_FALLBACK_MESSAGE =
  "⚠️ *Couldn't Process Audio*\n\nI couldn't process that voice message.\n\n_Please try again with a shorter voice note, or send the transaction as text._";

// Failures caused by the audio itself (missing, corrupted, unsupported
// format, or too long to transcribe in time) or by the download step that
// feeds it. Retrying the identical file will not help.
export const AUDIO_PROCESSING_ERROR_CODES = Object.freeze([
  'UNSUPPORTED_AUDIO',
  'MEDIA_DOWNLOAD_INVALID_INPUT',
  'MEDIA_DOWNLOAD_FAILED',
  'MEDIA_DOWNLOAD_INVALID_RESPONSE',
  'MEDIA_DOWNLOAD_TIMEOUT',
  'MEDIA_TEMP_WRITE_FAILED',
  'TRANSCRIPTION_READ_FAILED',
  'TRANSCRIPTION_INVALID_INPUT',
  'TRANSCRIPTION_INVALID_RESPONSE',
  'TRANSCRIPTION_BAD_AUDIO',
  'TRANSCRIPTION_TIMEOUT',
]);

// Failures on our side or the provider's side (missing API key, auth
// errors, transient provider errors) that have nothing to do with the
// specific audio file. These should use the same "system busy" messaging
// as other AI-unavailable errors, since a shorter recording will not help.
export const TRANSCRIPTION_SERVICE_BUSY_CODES = Object.freeze([
  'TRANSCRIPTION_CONFIG_ERROR',
  'TRANSCRIPTION_PROVIDER_ERROR',
  'TRANSCRIPTION_REQUEST_FAILED',
  'MEDIA_DOWNLOAD_CONFIG_ERROR',
]);

/**
 * True when the error is about the audio content/file rather than the AI
 * provider being busy — i.e. the fix is a different recording or plain text.
 */
export function isAudioProcessingError(err) {
  return AUDIO_PROCESSING_ERROR_CODES.includes(err?.code);
}

/**
 * True when the error means the transcription pipeline itself is
 * unavailable (config/auth/provider outage) rather than a problem with the
 * specific audio the user sent.
 */
export function isTranscriptionServiceBusyError(err) {
  return TRANSCRIPTION_SERVICE_BUSY_CODES.includes(err?.code);
}

export default {
  AUDIO_PROCESSING_FALLBACK_MESSAGE,
  AUDIO_PROCESSING_ERROR_CODES,
  TRANSCRIPTION_SERVICE_BUSY_CODES,
  isAudioProcessingError,
  isTranscriptionServiceBusyError,
};
