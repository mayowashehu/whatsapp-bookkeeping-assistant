import mongoose from 'mongoose';

/**
 * Tracks processed WhatsApp message IDs to prevent duplicate processing.
 * MongoDB TTL automatically removes old records.
 */
const processedMessageSchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 200,
    },

    senderId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },

    processedAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 7, // 7 days
    },
  },
  {
    timestamps: false,
  },
);

// processedMessageSchema.index({ messageId: 1 });

const ProcessedMessage = mongoose.model(
  'ProcessedMessage',
  processedMessageSchema,
);

export default ProcessedMessage;