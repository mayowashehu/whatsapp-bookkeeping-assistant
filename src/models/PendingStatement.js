import mongoose from 'mongoose';

const pendingStatementSchema = new mongoose.Schema(
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

    // Property resolved on an earlier turn (e.g. "Statement for Flat 2" —
    // property matched immediately, but month/year still pending). Kept
    // optional/nullable since a turn can resolve month/year before the
    // property just as easily as the reverse.
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property',
      default: null,
    },

    propertyName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },

    year: {
      type: Number,
      default: null,
    },

    month: {
      type: Number,
      default: null,
    },

    awaitingField: {
      type: String,
      default: 'property',
      trim: true,
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      index: { expires: '0s' },
    },
  },
  {
    timestamps: true,
  },
);

const PendingStatement = mongoose.model('PendingStatement', pendingStatementSchema);

export default PendingStatement;
