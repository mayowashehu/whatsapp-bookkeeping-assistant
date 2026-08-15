import { createAppError } from '../../utils/createAppError.js';

export const SUPPORTED_AUDIO_MIME_TYPES = Object.freeze([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
]);

/**
 * Normalizes a MIME type by stripping parameters (e.g. codecs).
 */
export function normalizeMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return '';
  }
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Returns true when the MIME type is supported for transcription.
 */
export function isSupportedAudioMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  return SUPPORTED_AUDIO_MIME_TYPES.includes(normalized);
}

/**
 * Throws if the audio MIME type is unsupported.
 */
export function assertSupportedAudioMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);

  if (!normalized) {
    throw createAppError('UNSUPPORTED_AUDIO', 'Audio MIME type is missing');
  }

  if (!isSupportedAudioMimeType(normalized)) {
    throw createAppError('UNSUPPORTED_AUDIO', `Unsupported audio MIME type: ${normalized}`);
  }

  return normalized;
}
