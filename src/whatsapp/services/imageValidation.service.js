import { createAppError } from '../../utils/createAppError.js';

// WhatsApp Cloud API only ever delivers inbound photo messages as JPEG or
// PNG (its own image-upload docs list these as the two accepted inbound
// image types — anything else the sender's client re-encodes before it
// reaches the webhook). Mirrors audioValidation.service.js's shape exactly
// so both validators can be swapped into the generalized
// downloadWhatsAppMedia() the same way — see mediaDownload.service.js.
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png']);

export const IMAGE_EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
});

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
 * Returns true when the MIME type is supported for receipt reading.
 */
export function isSupportedImageMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  return SUPPORTED_IMAGE_MIME_TYPES.includes(normalized);
}

/**
 * Throws if the image MIME type is unsupported.
 */
export function assertSupportedImageMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);

  if (!normalized) {
    throw createAppError('UNSUPPORTED_IMAGE', 'Image MIME type is missing');
  }

  if (!isSupportedImageMimeType(normalized)) {
    throw createAppError('UNSUPPORTED_IMAGE', `Unsupported image MIME type: ${normalized}`);
  }

  return normalized;
}

export default {
  SUPPORTED_IMAGE_MIME_TYPES,
  IMAGE_EXTENSION_BY_MIME,
  normalizeMimeType,
  isSupportedImageMimeType,
  assertSupportedImageMimeType,
};