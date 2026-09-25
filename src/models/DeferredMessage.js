import mongoose from 'mongoose';

/**
 * A text message whose processing failed ONLY because the AI provider was
 * unavailable (timeouts / 503 / 429). Instead of telling the user to resend,
 * we persist it and retry automatically with backoff — see
 * services/deferred/DeferredMessageService.js.
 *
 * Stored in MongoDB (not memory) so it survives Render restarts, deploys and
 * free-tier spin-downs.
 */
const deferredMessageSchema = new mongoose.Schema(
  {
    senderId: { type: String, required: true, trim: true, maxlength: 32 },
    text: { type: String, required: true, maxlength: 4000 },
    sourceMessageId: { type: String, trim: true, maxlength: 200 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
    // Number of RETRIES already made (the original inline attempt is not counted).
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    processingStartedAt: { type: Date },
    lastError: { type: String, maxlength: 300 },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 3, // auto-clean after 3 days
    },
  },
  { timestamps: false },
);

deferredMessageSchema.index({ senderId: 1, status: 1, createdAt: 1 });
deferredMessageSchema.index({ status: 1, nextAttemptAt: 1 });

const DeferredMessage = mongoose.model('DeferredMessage', deferredMessageSchema);

export default DeferredMessage;
