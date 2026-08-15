import mongoose from 'mongoose';

/**
 * Holds a single candidate entry found for a "flag this transaction for
 * review" request, awaiting the user's explicit YES/NO — same
 * confirm-before-acting shape as PendingDeletion. One per WhatsApp sender.
 */
const pendingFlagReviewSchema = new mongoose.Schema(
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

    // Task 3.3 follow-up — populated instead of entryId when a search
    // turned up more than one match, so a follow-up disambiguating reply
    // ("the one from August 1st") can narrow it down without the user
    // having to restate the whole request. Cleared once narrowed to one.
    candidates: {
      type: [Object],
      default: [],
    },

    // The user's original free-text request (e.g. "the 20k repairs payment
    // for Flat 2 — wrong category"), stored verbatim and saved onto the
    // entry as flagNote once confirmed.
    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
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

const PendingFlagReview = mongoose.model('PendingFlagReview', pendingFlagReviewSchema);

export default PendingFlagReview;
