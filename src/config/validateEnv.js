/**
 * Required environment variables for a real pilot startup.
 * The HTTP server must not start if any of these are missing.
 */
export const REQUIRED_ENV_VARS = Object.freeze([
  'MONGODB_URI',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'GEMINI_MODEL',
]);

/**
 * Validates required env vars. Throws a single Error listing every missing key.
 */
export function assertRequiredEnv(envSource = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((key) => {
    const value = envSource[key];
    return value === undefined || value === null || String(value).trim() === '';
  });

  const hasGeminiKey =
    String(envSource.GEMINI_API_KEY || '').trim() !== '' ||
    String(envSource.GEMINI_API_KEYS || '').trim() !== '';
  if (!hasGeminiKey) {
    missing.push('GEMINI_API_KEY');
  }

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Set them in your .env file before starting the server.',
  );
}

export default {
  REQUIRED_ENV_VARS,
  assertRequiredEnv,
};
