# WhatsApp Bookkeeping Assistant

AI-powered bookkeeping assistant for independent property managers. Version **v0.1** is WhatsApp-first: log income/expenses, answer bookkeeping questions, and generate investor PDF statements — all from chat.

> Scope is intentionally narrow: one pilot user, known properties, confirmation before every save. See `PROJECT_CONTEXT.md` and `TASK.md`.

## Requirements

- Node.js 20+
- MongoDB (connection wired in a later milestone)

## Setup

```bash
npm install
cp .env.example .env
```

## Database (MongoDB Atlas)

1. Create a free cluster in [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a database user and allow network access (your IP or `0.0.0.0/0` for pilot).
3. Copy the connection string and set it in `.env`:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/whatsapp-bookkeeping?retryWrites=true&w=majority
```

4. Start the server:

```bash
npm start
```

Success looks like:

```
MongoDB connected
Server listening on port 5000 (development)
```

If `MONGODB_URI` is missing or Atlas is unreachable, the process logs the error and exits.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` (auto-restart) |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |

## WhatsApp webhook

Endpoints:

- `GET /webhook` — Meta verification challenge
- `POST /webhook` — inbound messages (requires valid `X-Hub-Signature-256`)

Set in `.env`:

```env
WHATSAPP_VERIFY_TOKEN=your-random-verify-token
META_APP_SECRET=your-meta-app-secret
```

Public URL example (tunnel or deploy): `https://YOUR_HOST/webhook`

## Voice transcription (Gemini)

```env
GEMINI_API_KEY=your-google-ai-studio-key
GEMINI_MODEL=gemini-2.0-flash
GEMINI_CLASSIFIER_MODEL=gemini-2.0-flash
GEMINI_PARSER_MODEL=gemini-2.0-flash
CLASSIFICATION_MIN_CONFIDENCE=0.7
AI_TIMEOUT_MS=30000
DOWNLOAD_TIMEOUT_MS=30000
TRANSCRIPTION_TIMEOUT_MS=60000
WHATSAPP_ACCESS_TOKEN=your-cloud-api-token
```

Inbound voice notes are downloaded, transcribed, classified, and (for `LOG_ENTRY`) parsed into a draft that is logged only. No WhatsApp reply or DB write of entries in this milestone.

## Health check

```bash
Invoke-RestMethod -Uri http://localhost:5000/health
```

## Project structure

```
src/
  app.js              # Express app (middleware + routes)
  server.js           # Process entry — listens on PORT
  config/             # Environment + MongoDB connection
  controllers/        # HTTP handlers (no business logic)
  routes/             # Route definitions
  services/           # Shared services (property lookup, correction patch builder)
  services/draft/     # Draft lifecycle (manager, repo, confirm, correct, format)
  services/query/     # Read-only query engine (interpret, aggregate, format)
  statement/          # Monthly statement orchestration + calculations
  pdf/                # PDFKit rendering only
  models/             # Mongoose models
  middleware/         # Logging, errors, 404, WhatsApp signature
  utils/              # Shared helpers
  validators/         # Input validation (later)
  prompts/            # AI prompt templates
  whatsapp/           # WhatsApp Cloud API webhook, media download, send, routing
  transcription/      # Generic TranscriptionService + Gemini provider
  pdf/                # PDF generation (later)
  statement/          # Statement assembly (later)
  ai/                 # Classification / parsing
```

## Architecture notes

- **Controllers stay thin.** Business rules belong in services.
- **`app.js` vs `server.js`.** The app is exportable for tests; the server owns process lifecycle.
- **MongoDB connects on startup.** Missing `MONGODB_URI` or a failed initial connection terminates the process.
- **WhatsApp webhook** validates Meta signatures, normalizes inbound text/audio, and routes asynchronously.
- **Transcription** is provider-agnostic via `createTranscriptionService()`.
- **Classification / parsing** use generic `AIService`; Gemini stays in `providers/`. Parser is pure and receives `knownProperties` from the caller.
- **DraftManager** owns pending-draft lifecycle; confirmation saves an Entry atomically and then removes the draft. Replies are sent on WhatsApp.
- **QueryManager** answers read-only questions from confirmed Entry records via MongoDB aggregations (AI may interpret questions only).
- **StatementManager** builds investor PDFs for a calendar month; PDFKit rendering stays isolated in `src/pdf/`.
- **Document delivery** uploads/sends PDFs via a shared `MetaApiClient` (retry + timeout). Statement wiring comes later.

## Current milestone

Phase 6 — Task 15: WhatsApp PDF document delivery (delivery only).
