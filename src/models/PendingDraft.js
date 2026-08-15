import mongoose from 'mongoose';
import { ENTRY_TYPES } from './Entry.js';


/**
 * Partial draft.
 *
 * Unlike Entry, almost every field is optional because
 * clarification happens over multiple WhatsApp messages.
 */
const draftEntrySchema = new mongoose.Schema(
  {
    type: {
      type: String,
     // enum: ENTRY_TYPES,
    },

    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      default: null,
    },

    pendingNewPropertyName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },

    amount: {
      type: Number,
      default: null,
      min: 0.01,
    },

    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    sourceText: {
      type: String,
      default: '',
      trim: true,
      maxlength: 4000,
    },

    transactionDate: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  },
);

/**
 * Tracks clarification progress.
 */
const clarificationSchema = new mongoose.Schema(
  {
    awaiting: {
      type: Boolean,
      default: false,
    },

    missingFields: {
      type: [String],
      default: [],
    },

    question: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    _id: false,
  },
);

/**
 * One pending draft per WhatsApp sender.
 */
const pendingDraftSchema = new mongoose.Schema(
  {
    fromNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
    },
      
    draftEntry: {
      type: draftEntrySchema,
      required: true,
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      index: { expires: '0s' } 
    },

    clarification: {
      type: clarificationSchema,
      default: () => ({
        awaiting: false,
        missingFields: [],
        question: '',
      }),
    },

        // FIX (W, follow-through): when a message contains more than one
    // transaction, only the first is ever turned into a draft — that's
    // intentional. But the remaining items can't just be discarded once
    // detected: this holds the rest of the batch (already fully
    // normalized — see TransactionParser.js) so DraftManager.js can
    // automatically advance to the next one once the current draft is
    // saved, instead of a user's natural "what about the second one?"
    // hitting a dead end (real bug found in live WhatsApp testing — see
    // CHANGES.md). Mixed on purpose: these are transient, already-shaped
    // plain objects consumed immediately on the next confirmation, not a
    // durable schema worth its own strict sub-document.
    queuedTransactions: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },

    // Tracks whether DraftReminderService has already nudged this sender
    // about this draft. Must be a real schema path — Mongoose's default
    // strict mode silently drops any field set on a document that isn't
    // declared here, so without this the reminder daemon would find the
    // same "stale" draft on every 30-minute poll and re-send the reminder
    // indefinitely instead of once.
    reminderSent: {
      type: Boolean,
      default: false,
    },

    // Duplicate Detection (PROJECT_CONTEXT.md). Records the fingerprint
    // (type|property|amount — see duplicateDetection.service.js) of the
    // draft shape the user has already been warned about and chose to
    // save anyway. Compared against the draft's CURRENT fingerprint at
    // confirmation time: matches → skip the warning (already asked and
    // answered); differs → the draft was corrected since, or this is the
    // first attempt, so the check runs again. Self-resetting on any
    // correction with no extra logic needed elsewhere.
    duplicateWarning: {
      warnedFingerprint: {
        type: String,
        default: null,
      },
    },
  },
  
  {
    timestamps: true,
  },
);

const PendingDraft = mongoose.model(
  'PendingDraft',
  pendingDraftSchema,
);

export default PendingDraft;