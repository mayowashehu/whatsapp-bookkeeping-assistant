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
  // Optional extra keys (comma-separated). Free-tier 429s are often per-key;
  // GeminiAIService rotates through this pool on overload without billing.
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
  // Per-attempt timeout on later retry rounds. Free-tier Gemini often
  // queues for 6–10s under "high demand"; aborting at 4s was cutting off
  // requests that would have succeeded. First-pass hops still clamp to 5s
  // inside GeminiAIService so one hung model cannot eat the whole budget.
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS) || 8000,
  // Total wall-clock budget for one AI call: model hops + key rotation +
  // a short backoff retry when every candidate returns 429/503/timeout.
  // Sized for one human on the free tier, not a paid SLA. Concurrency
  // locks MUST derive TTL from this (a turn can classify then parse).
  aiTotalBudgetMs: Number(process.env.AI_TOTAL_BUDGET_MS) || 32000,
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