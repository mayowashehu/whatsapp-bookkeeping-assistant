import mongoose from 'mongoose';

const pendingDeletionSchema = new mongoose.Schema(
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
      required: true,
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

const PendingDeletion = mongoose.model('PendingDeletion', pendingDeletionSchema);

export default PendingDeletion;
