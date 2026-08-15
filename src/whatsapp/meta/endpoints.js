import env from '../../config/env.js';

/**
 * Centralized WhatsApp / Meta Graph API endpoint builders.
 * Keep all Cloud API paths in one place.
 */
export function getGraphBaseUrl(version = env.whatsapp.graphApiVersion) {
  return `https://graph.facebook.com/${version}`;
}

export const metaEndpoints = {
  messages(phoneNumberId = env.whatsapp.phoneNumberId) {
    return `${getGraphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/messages`;
  },

  mediaUpload(phoneNumberId = env.whatsapp.phoneNumberId) {
    return `${getGraphBaseUrl()}/${encodeURIComponent(phoneNumberId)}/media`;
  },

  mediaObject(mediaId) {
    return `${getGraphBaseUrl()}/${encodeURIComponent(mediaId)}`;
  },
};

export default metaEndpoints;
