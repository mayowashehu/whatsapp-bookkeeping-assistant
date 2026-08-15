import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppError } from '../../utils/createAppError.js';
import { createMetaApiClient } from '../meta/MetaApiClient.js';
import { assertSupportedAudioMimeType } from './audioValidation.service.js';

const AUDIO_EXTENSION_BY_MIME = Object.freeze({
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
});

/**
 * Downloads a WhatsApp Cloud API media object to the OS temp directory.
 * Uses the shared MetaApiClient gateway.
 *
 * FIX (3.1): this used to be hardwired to audio — the mime validator, the
 * extension map, and the temp filename prefix were all baked in. Nothing
 * about downloading a binary from Meta's media endpoint is actually
 * audio-specific, so rather than duplicating this whole file for images
 * (receipt photos), the three audio-specific pieces are now injectable via
 * `options`, each defaulting to the original audio behavior so every
 * existing caller (VoiceMessageService) keeps working with zero changes.
 * ReceiptMessageService.js passes the image equivalents of all three.
 */
export async function downloadWhatsAppMedia(mediaId, options = {}) {
  if (!mediaId) {
    throw createAppError('MEDIA_DOWNLOAD_INVALID_INPUT', 'mediaId is required');
  }

  const metaClient = options.metaClient || createMetaApiClient();
  const assertSupportedMimeType = options.assertSupportedMimeType || assertSupportedAudioMimeType;
  const extensionByMime = options.extensionByMime || AUDIO_EXTENSION_BY_MIME;
  const filePrefix = options.filePrefix || 'wa-audio';

  const meta = await fetchMediaMetadata(metaClient, mediaId);
  const mimeType = assertSupportedMimeType(options.mimeType || meta.mimeType);
  const filePath = await downloadBinaryToTempFile(metaClient, meta.url, mediaId, mimeType, extensionByMime, filePrefix);

  return {
    filePath,
    mimeType,
    mediaId: String(mediaId),
  };
}

async function fetchMediaMetadata(metaClient, mediaId) {
  const result = await metaClient.getMediaMetadata(mediaId);
  if (!result.success) {
    throw createAppError(
      mapMediaErrorCode(result.error?.code, 'MEDIA_DOWNLOAD_FAILED'),
      result.error?.message || 'Failed to fetch WhatsApp media metadata',
    );
  }

  if (!result.data?.url) {
    throw createAppError(
      'MEDIA_DOWNLOAD_INVALID_RESPONSE',
      'WhatsApp media metadata response missing url',
    );
  }

  return {
    url: String(result.data.url),
    // NOTE: this is a pure MIME-string helper with no audio-specific logic
    // (imageValidation.service.js has an identical copy for its own
    // module boundary) — kept local here rather than imported so this file
    // has no dependency on either validator module beyond the default.
    mimeType: result.data.mime_type ? normalizeMimeTypeLoose(result.data.mime_type) : '',
  };
}

function normalizeMimeTypeLoose(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return '';
  return mimeType.split(';')[0].trim().toLowerCase();
}

async function downloadBinaryToTempFile(metaClient, mediaUrl, mediaId, mimeType, extensionByMime, filePrefix) {
  const result = await metaClient.requestBinary({ url: mediaUrl, retry: true });
  if (!result.success) {
    throw createAppError(
      mapMediaErrorCode(result.error?.code, 'MEDIA_DOWNLOAD_FAILED'),
      result.error?.message || 'Failed to download WhatsApp media binary',
    );
  }

  const buffer = result.data;
  if (!buffer?.length) {
    throw createAppError('MEDIA_DOWNLOAD_FAILED', 'Downloaded WhatsApp media file is empty');
  }

  const extension = extensionByMime[mimeType] || '.bin';
  const fileName = `${filePrefix}-${mediaId}-${Date.now()}${extension}`;
  const filePath = path.join(os.tmpdir(), fileName);

  try {
    await fs.writeFile(filePath, buffer);
  } catch (err) {
    throw createAppError(
      'MEDIA_TEMP_WRITE_FAILED',
      `Failed to write temporary media file: ${err.message}`,
      { cause: err },
    );
  }

  return filePath;
}

function mapMediaErrorCode(code, fallback) {
  if (code === 'WHATSAPP_TIMEOUT') return 'MEDIA_DOWNLOAD_TIMEOUT';
  if (code === 'WHATSAPP_AUTH_ERROR') return 'MEDIA_DOWNLOAD_CONFIG_ERROR';
  return fallback;
}

/**
 * Deletes a temporary file if it exists. Never throws (logs instead).
 * Despite the name (kept for backward compatibility — VoiceMessageService
 * already imports it), this is pure fs.unlink with no audio-specific
 * behavior at all, so it's equally correct for a downloaded receipt photo.
 */
export async function deleteTempAudioFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(
        `[mediaDownload] Failed to delete temp file path=${filePath}: ${err.message}`,
      );
    }
  }
}

// FIX (3.1): plain alias so new, non-audio call sites (ReceiptMessageService)
// don't have to import a function named "...AudioFile" for a receipt photo.
// Same function, not a copy — nothing to keep in sync.
export const deleteTempMediaFile = deleteTempAudioFile;

export default {
  downloadWhatsAppMedia,
  deleteTempAudioFile,
  deleteTempMediaFile,
};