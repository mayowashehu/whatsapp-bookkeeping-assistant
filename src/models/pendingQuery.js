import mongoose from 'mongoose';

/**
 * Tracks a QUERY that was understood (e.g. "how much did I spend?") but was
 * too broad to answer — no period, no property, no category. QueryManager
 * asks "this month, this year, or a specific property?" and persists the
 * queryType/category it already resolved here, so the next short reply
 * ("for July", "Flat 2", "this year") can be merged in as the missing
 * scope instead of being re-classified from nothing.
 *
 * Short TTL relative to PendingDraft/PendingStatement — a scope answer is
 * expected within the same short back-and-forth, not hours later.
 */
const pendingQuerySchema = new mongoose.Schema(
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

    queryType: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: String,
      default: null,
      trim: true,
      maxlength: 80,
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      index: { expires: '0s' },
    },
  },
  {
    timestamps: true,
  },
);

const PendingQuery = mongoose.model('PendingQuery', pendingQuerySchema);

export default PendingQuery;
