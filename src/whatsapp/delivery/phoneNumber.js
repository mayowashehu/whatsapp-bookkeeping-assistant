/**
 * Phone number normalization for WhatsApp Cloud API.
 * Accepts optional leading +, strips formatting, returns digits-only E.164.
 */

export function normalizeWhatsAppPhoneNumber(input) {
  if (input === null || input === undefined) {
    return {
      ok: false,
      phoneNumber: null,
      error: {
        code: 'INVALID_PHONE_NUMBER',
        message: 'Phone number is required',
      },
    };
  }

  let value = String(input).trim();
  if (!value) {
    return {
      ok: false,
      phoneNumber: null,
      error: {
        code: 'INVALID_PHONE_NUMBER',
        message: 'Phone number is required',
      },
    };
  }

  if (value.startsWith('+')) {
    value = value.slice(1);
  }

  value = value.replace(/[\s\-()]/g, '');

  if (!/^\d{8,15}$/.test(value)) {
    return {
      ok: false,
      phoneNumber: null,
      error: {
        code: 'INVALID_PHONE_NUMBER',
        message: 'Phone number must contain 8–15 digits (optional leading +)',
      },
    };
  }

  return {
    ok: true,
    phoneNumber: value,
    error: null,
  };
}

export default {
  normalizeWhatsAppPhoneNumber,
};
