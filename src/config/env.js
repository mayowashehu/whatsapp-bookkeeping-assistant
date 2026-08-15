import dotenv from 'dotenv';
import {
  getGeminiClassifierModel,
  getGeminiModel,
  getGeminiParserModel,
  getGeminiQueryModel,
} from '../services/ai/geminiClient.js';

dotenv.config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  watTimezone: process.env.WAT_TIMEZONE || 'Africa/Lagos',
  businessName: process.env.BUSINESS_NAME || 'Luxe BNB',
  mongodbUri: process.env.MONGODB_URI || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: getGeminiModel(),
  geminiClassifierModel: getGeminiClassifierModel(),
  geminiParserModel: getGeminiParserModel(),
  geminiQueryModel: getGeminiQueryModel(),
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS) || 30000,
  transcriptionTimeoutMs: Number(process.env.TRANSCRIPTION_TIMEOUT_MS) || 60000,
  // FIX (3.1): mirrors transcriptionTimeoutMs's own default — a vision call
  // over one receipt photo is a comparable single-media-file AI round trip
  // to transcribing one voice note, so it gets the same generous budget
  // (separate from aiTimeoutMs/aiTotalBudgetMs below, which are sized for
  // fast text-only JSON extraction, not a media upload).
  receiptTimeoutMs: Number(process.env.RECEIPT_TIMEOUT_MS) || 60000,
  // FIX (Phase 1.0c, 🔴 — confirmed live): lowered from 30000. A real
  // flash/flash-lite model that's actually available answers in 1-3s — if
  // it hasn't responded within a few seconds, waiting the rest of a 30s
  // window out never helps, it just holds the user's WhatsApp chat open.
  // Failing a single attempt fast is what makes trying several curated
  // fallback candidates (see geminiClient.js) affordable within the total
  // budget below instead of eating the whole budget on one hung request.
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS) || 4000,
  // Total wall-clock budget for a single AI call INCLUDING every fallback
  // model attempt (see GeminiAIService.js's curated, sticky-first attempt
  // order). FIX (Phase 1.0c, 🔴 — confirmed live): lowered from 90000.
  // Real testing measured a single message taking 43-45s under the old
  // dynamic-discovery fallback; with that discovery step removed and a
  // short curated candidate list in its place, 4-5 fast attempts
  // comfortably fit inside ~9-10s. If nothing in the curated list answers
  // within this budget, the caller gets a fast, honest "still busy"
  // response instead of silence.
  // Anything holding a per-sender lock for the duration of an AI call
  // (see concurrencyLocks.js) MUST derive its safety timeout from this
  // value, not choose an independent number — a mismatch there is exactly
  // what let a still-in-flight turn's lock get force-released mid-call.
  aiTotalBudgetMs: Number(process.env.AI_TOTAL_BUDGET_MS) || 9000,
  classificationMinConfidence: Number(process.env.CLASSIFICATION_MIN_CONFIDENCE) || 0.7,
  // Phase 6.3 — mirrors classificationMinConfidence's floor, but for the
  // transaction-parsing layer (AiParsingService/TransactionParser), which
  // previously had no confidence gate at all. Kept as its own separate env
  // var (not reused) since parsing extraction is a noisier task than
  // intent classification and may reasonably warrant a different floor.
  parsingMinConfidence: Number(process.env.PARSING_MIN_CONFIDENCE) || 0.6,
  queryLastN: Number(process.env.QUERY_LAST_N) || 5,
  whatsapp: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.META_APP_SECRET || '',
    graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0',
    apiTimeoutMs: Number(process.env.WHATSAPP_API_TIMEOUT_MS) || 30000,
    apiMaxRetries: Number(process.env.WHATSAPP_API_MAX_RETRIES) || 3,
  },
};

export default env;