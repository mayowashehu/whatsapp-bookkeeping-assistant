import mongoose from 'mongoose';

/**
 * Tracks an in-progress "edit an already-confirmed transaction" request.
 * Two stages, same shape as the rest of this app's pending-state flows
 * (find -> ask -> act only on explicit YES):
 *   - AWAITING_CHANGES: the target entry is located; waiting for the user
 *     to say what should change (e.g. "change the amount to 25,000").
 *   - AWAITING_CONFIRMATION: a patch has been parsed and previewed;
 *     waiting for an explicit YES/NO before it's applied.
 */
const pendingEntryEditSchema = new mongoose.Schema(
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

    stage: {
      type: String,
      enum: {
        values: ['AWAITING_SELECTION', 'AWAITING_CHANGES', 'AWAITING_CONFIRMATION'],
        message: 'stage must be AWAITING_SELECTION, AWAITING_CHANGES, or AWAITING_CONFIRMATION',
      },
      required: true,
      default: 'AWAITING_CHANGES',
    },

    // Task 3.3 follow-up — populated instead of entryId while stage is
    // AWAITING_SELECTION (a search turned up more than one match). See
    // PendingFlagReview.js for the reasoning.
    candidates: {
      type: [Object],
      default: [],
    },

    // Resolved patch (amount/property/category/type/description/
    // transactionDate) once parsed in the AWAITING_CHANGES step. Empty
    // while still in AWAITING_CHANGES.
    patch: {
      type: Object,
      default: {},
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

const PendingEntryEdit = mongoose.model('PendingEntryEdit', pendingEntryEditSchema);

export default PendingEntryEdit;
