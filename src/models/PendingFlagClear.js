import mongoose from 'mongoose';

/**
 * Holds a single candidate FLAGGED entry found for a "clear this flag /
 * mark reviewed" request, awaiting the user's explicit YES/NO. Same
 * confirm-before-acting shape as PendingDeletion / PendingFlagReview.
 */
const pendingFlagClearSchema = new mongoose.Schema(
  {
    fromNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
    },

    senderId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },

    entryId: {
      type: String,
      required: false,
      default: null,
    },

    // Task 3.3 follow-up — see PendingFlagReview.js for the reasoning.
    candidates: {
      type: [Object],
      default: [],
    },

    entrySnapshot: {
      type: Object,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

const PendingFlagClear = mongoose.model('PendingFlagClear', pendingFlagClearSchema);

export default PendingFlagClear;
