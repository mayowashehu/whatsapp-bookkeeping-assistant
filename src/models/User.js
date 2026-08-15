import mongoose from 'mongoose';

/**
 * User model to track WhatsApp users permanently.
 * Stores sender ID (phone number) and first seen date.
 */
const userSchema = new mongoose.Schema(
  {
    senderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 32,
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

const User = mongoose.model('User', userSchema);

export default User;
