import mongoose from 'mongoose';

export const ENTRY_TYPES = Object.freeze(['income', 'expense']);
export const ENTRY_STATUSES = Object.freeze(['confirmed', 'undone', 'deleted']);

function categoryRequiredForExpense() {
  if (this.type === 'expense') {
    return typeof this.category === 'string' && this.category.trim().length > 0;
  }
  // Income: category must be null/undefined (optional).
  return this.category === null || this.category === undefined;
}

/**
 * Entry — a confirmed bookkeeping record.
 *
 * Only created after explicit user confirmation (never auto-saved).
 * status supports later undo/delete without hard-removing history.
 * category is required for expenses and null for income.
 */
const entrySchema = new mongoose.Schema(
  {
    // WhatsApp sender ID that owns this entry
    senderId: {
      type: String,
      required: [true, 'senderId is required for entry'],
      trim: true,
      maxlength: 32,
      // Fallback for existing pilot user records
      default: 'pilot-user',
    },

    type: {
      type: String,
      enum: {
        values: ENTRY_TYPES,
        message: 'type must be income or expense',
      },
      required: [true, 'Entry type is required'],
    },

    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      required: [true, 'Property is required'],
    },

    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [0.01, 'Amount must be greater than zero'],
    },

    // Required for expenses; null for income (domain-accurate, no placeholder labels).
    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: [80, 'Category cannot exceed 80 characters'],
     validate: {
        validator: categoryRequiredForExpense,
        message: 'category is required for expenses and must be null for income',
      },
    },

    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },

    sourceText: {
      type: String,
      required: [true, 'sourceText is required'],
      trim: true,
      maxlength: [4000, 'sourceText cannot exceed 4000 characters'],
    },

    transactionDate: {
      type: Date,
      required: [true, 'transactionDate is required'],
    },

    confirmedAt: {
      type: Date,
      required: [true, 'confirmedAt is required'],
    },

    status: {
      type: String,
      enum: {
        values: ENTRY_STATUSES,
        message: 'status must be confirmed, undone, or deleted',
      },
      required: [true, 'status is required'],
      default: 'confirmed',
    },

    // Task 3.2 — path for correcting an already-confirmed transaction.
    // Deliberately NOT a `status` value: flagging must never change how an
    // entry behaves in queries/statements (it still counts exactly as
    // before). It only marks the entry as needing a human look, alongside
    // a free-text note of what looks wrong, so a mistake noticed days
    // later isn't silently unfixable — the user (or, later, a human
    // reviewer) can find it and correct it deliberately instead of the
    // assistant guessing at an edit to a record it can no longer safely
    // treat as "the last one".
    flaggedForReview: {
      type: Boolean,
      default: false,
    },

    // Why the entry was flagged (e.g. "amount looks wrong", "wrong
    // property"). Only meaningful while flaggedForReview is true, but left
    // in place after unflagging as a record of the last reason raised.
    flagNote: {
      type: String,
      default: null,
      trim: true,
      maxlength: [500, 'flagNote cannot exceed 500 characters'],
    },

    flaggedAt: {
      type: Date,
      default: null,
    },

    // Task 3.3 — set whenever a confirmed entry is corrected via
    // editConfirmedTransaction.service.js. null means "as originally
    // confirmed, never touched since."
    editedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

entrySchema.index({ senderId: 1, property: 1, transactionDate: -1 });
entrySchema.index({ senderId: 1, status: 1, transactionDate: -1 });
entrySchema.index({ senderId: 1, createdAt: -1 });
entrySchema.index({ senderId: 1, category: 1, status: 1, transactionDate: -1 });
// Supports findConfirmedMatches (flagTransactionForReview.service.js) and any
// future "show my flagged entries" query without a collection scan.
entrySchema.index({ senderId: 1, status: 1, amount: 1, property: 1 });
entrySchema.index({ senderId: 1, flaggedForReview: 1, transactionDate: -1 });

const Entry = mongoose.model('Entry', entrySchema);

export default Entry;
