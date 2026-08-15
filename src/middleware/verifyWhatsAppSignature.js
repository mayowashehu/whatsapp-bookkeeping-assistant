import crypto from 'node:crypto';
import env from '../config/env.js';
import { createError } from '../utils/createError.js';

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body.
 * Requires app.js to preserve req.rawBody via express.json verify option.
 */
export function verifyWhatsAppSignature(req, _res, next) {
  const appSecret = env.whatsapp.appSecret;

  if (!appSecret) {
    next(createError('META_APP_SECRET is not configured', 500));
    return;
  }

  const signatureHeader = req.get('x-hub-signature-256');

  if (!signatureHeader) {
    next(createError('Missing X-Hub-Signature-256 header', 401));
    return;
  }

  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    next(createError('Raw request body unavailable for signature verification', 400));
    return;
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');

  const provided = Buffer.from(signatureHeader);
  const calculated = Buffer.from(expected);

  if (provided.length !== calculated.length || !crypto.timingSafeEqual(provided, calculated)) {
    next(createError('Invalid WhatsApp webhook signature', 403));
    return;
  }

  next();
}
