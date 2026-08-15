import fs from 'node:fs/promises';
import path from 'node:path';
import env from '../../config/env.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { metaEndpoints } from './endpoints.js';
import { retryRequest } from './retryRequest.js';

/**
 * Single gateway for Meta WhatsApp Cloud API requests.
 * Normalizes transport errors. Does not expose raw Meta payloads to callers —
 * returns { success, data, error } only.
 */
export function createMetaApiClient(overrides = {}) {
  const accessToken = overrides.accessToken ?? env.whatsapp.accessToken;
  const phoneNumberId = overrides.phoneNumberId ?? env.whatsapp.phoneNumberId;
  const timeoutMs = overrides.timeoutMs ?? env.whatsapp.apiTimeoutMs;
  const maxRetries = overrides.maxRetries ?? env.whatsapp.apiMaxRetries;
  const fetchImpl = overrides.fetchImpl || fetchWithTimeout;
  const sleep = overrides.sleep;

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${accessToken}`,
      ...extra,
    };
  }

  function ensureConfig() {
    if (!accessToken) {
      return failure('WHATSAPP_AUTH_ERROR', 'WHATSAPP_ACCESS_TOKEN is not configured', {
        status: 401,
      });
    }
    if (!phoneNumberId) {
      return failure('WHATSAPP_CONFIG_ERROR', 'WHATSAPP_PHONE_NUMBER_ID is not configured');
    }
    return null;
  }

  /**
   * Low-level JSON request against a Meta URL.
   */
  async function requestJson({ method, url, body, headers = {}, retry = true }) {
    const configError = ensureConfig();
    if (configError) {
      return configError;
    }

    const run = async () => {
      try {
        const response = await fetchImpl(
          url,
          {
            method,
            headers: authHeaders(headers),
            body,
          },
          timeoutMs,
        );

        let payload = null;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
        }

        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: normalizeMetaHttpError(response.status, payload),
          };
        }

        return {
          ok: true,
          status: response.status,
          payload,
        };
      } catch (err) {
        if (err?.code === 'TIMEOUT') {
          return {
            ok: false,
            status: 408,
            error: {
              code: 'WHATSAPP_TIMEOUT',
              message: `Meta API request timed out after ${timeoutMs}ms`,
            },
          };
        }
        return {
          ok: false,
          status: 0,
          error: {
            code: 'WHATSAPP_NETWORK_ERROR',
            message: err.message || 'Meta API network error',
          },
        };
      }
    };

    const result = retry
      ? await retryRequest(run, { maxRetries, sleep })
      : await run();

    if (!result.ok) {
      return failure(result.error.code, result.error.message, {
        status: result.status,
      });
    }

    return success(result.payload);
  }

  /**
   * Binary/raw GET (e.g. media download URL).
   */
  async function requestBinary({ url, retry = true }) {
    const configError = ensureConfig();
    if (configError) {
      return configError;
    }

    const run = async () => {
      try {
        const response = await fetchImpl(
          url,
          {
            method: 'GET',
            headers: authHeaders(),
          },
          timeoutMs,
        );

        if (!response.ok) {
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          return {
            ok: false,
            status: response.status,
            error: normalizeMetaHttpError(response.status, payload),
          };
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          ok: true,
          status: response.status,
          payload: buffer,
        };
      } catch (err) {
        if (err?.code === 'TIMEOUT') {
          return {
            ok: false,
            status: 408,
            error: {
              code: 'WHATSAPP_TIMEOUT',
              message: `Meta API request timed out after ${timeoutMs}ms`,
            },
          };
        }
        return {
          ok: false,
          status: 0,
          error: {
            code: 'WHATSAPP_NETWORK_ERROR',
            message: err.message || 'Meta API network error',
          },
        };
      }
    };

    const result = retry
      ? await retryRequest(run, { maxRetries, sleep })
      : await run();

    if (!result.ok) {
      return failure(result.error.code, result.error.message, {
        status: result.status,
      });
    }

    return success(result.payload);
  }

  /**
   * Reusable media upload pipeline (documents, images, audio, etc.).
   */
  async function uploadMedia({ filePath, mimeType, filename }) {
    const configError = ensureConfig();
    if (configError) {
      return configError;
    }

    let fileBuffer;
    try {
      fileBuffer = await fs.readFile(filePath);
    } catch (err) {
      return failure('WHATSAPP_FILE_READ_ERROR', `Unable to read media file: ${err.message}`);
    }

    if (!fileBuffer.length) {
      return failure('WHATSAPP_FILE_EMPTY', 'Media file is empty');
    }

    const safeName = filename || path.basename(filePath);
    const url = metaEndpoints.mediaUpload(phoneNumberId);

    const result = await retryRequest(
      async () => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append(
          'file',
          new Blob([new Uint8Array(fileBuffer)], { type: mimeType }),
          safeName,
        );

        try {
          const response = await fetchImpl(
            url,
            {
              method: 'POST',
              headers: authHeaders(),
              body: form,
            },
            timeoutMs,
          );

          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }

          if (!response.ok) {
            return {
              ok: false,
              status: response.status,
              error: normalizeMetaHttpError(response.status, payload),
            };
          }

          return {
            ok: true,
            status: response.status,
            payload,
          };
        } catch (err) {
          if (err?.code === 'TIMEOUT') {
            return {
              ok: false,
              status: 408,
              error: {
                code: 'WHATSAPP_TIMEOUT',
                message: `Meta API request timed out after ${timeoutMs}ms`,
              },
            };
          }
          return {
            ok: false,
            status: 0,
            error: {
              code: 'WHATSAPP_NETWORK_ERROR',
              message: err.message || 'Meta API network error',
            },
          };
        }
      },
      { maxRetries, sleep },
    );

    if (!result.ok) {
      return failure(result.error.code, result.error.message, {
        status: result.status,
      });
    }

    const mediaId = result.payload?.id;
    if (!mediaId) {
      return failure('WHATSAPP_MEDIA_ID_MISSING', 'Meta upload response did not include a media id');
    }

    return success({ mediaId: String(mediaId) });
  }

  async function sendMessage(payload) {
    return requestJson({
      method: 'POST',
      url: metaEndpoints.messages(phoneNumberId),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      retry: true,
    });
  }

  async function markMessageAsRead(messageId, { showTyping = false } = {}) {
    return requestJson({
      method: 'POST',
      url: metaEndpoints.messages(phoneNumberId),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        // FIX (Phase 1.6, 🔴 — confirmed live): Meta's Cloud API supports
        // combining the read-receipt call with the native "typing…"
        // indicator in a single request via this field. Previously this
        // app sent a throwaway "Got it, processing your request..." text
        // message as its "we're working on it" signal, as a SEPARATE
        // sequential API call from marking the message read — two round
        // trips, plus a text bubble the user has to read and dismiss.
        // Passing showTyping:true here does both jobs in one request: the
        // blue checkmarks appear AND the native typing animation shows
        // immediately, before any AI/DB work starts (see
        // webhookReceive.service.js). It's automatically dismissed by
        // WhatsApp the moment the real reply is sent, or after ~25s,
        // whichever comes first — no extra bookkeeping needed here.
        ...(showTyping ? { typing_indicator: { type: 'text' } } : {}),
      }),
      retry: false, // Don't retry read receipts - if it fails, it's fine
    });
  }

  async function getMediaMetadata(mediaId) {
    return requestJson({
      method: 'GET',
      url: metaEndpoints.mediaObject(mediaId),
      retry: true,
    });
  }

  return {
    requestJson,
    requestBinary,
    uploadMedia,
    sendMessage,
    markMessageAsRead,
    getMediaMetadata,
  };
}

function normalizeMetaHttpError(status, payload) {
  const apiMessage = payload?.error?.message || `HTTP ${status}`;
  const apiCode = payload?.error?.code;

  if (status === 401 || status === 403 || apiCode === 190) {
    return {
      code: 'WHATSAPP_AUTH_ERROR',
      message: `WhatsApp authentication failed: ${apiMessage}`,
    };
  }

  if (status === 429) {
    return {
      code: 'WHATSAPP_RATE_LIMITED',
      message: `WhatsApp rate limited: ${apiMessage}`,
    };
  }

  return {
    code: 'WHATSAPP_API_ERROR',
    message: apiMessage,
  };
}

function success(data) {
  return {
    success: true,
    data,
    error: null,
  };
}

function failure(code, message, extra = {}) {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      ...extra,
    },
  };
}

export default {
  createMetaApiClient,
};
