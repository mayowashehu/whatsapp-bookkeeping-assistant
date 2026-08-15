
import mongoose from 'mongoose';

/**
 * ChatMessage model to track conversation history per user.
 * Stores both user messages and bot replies for context injection.
 */
const chatMessageSchema = new mongoose.Schema(
  {
    senderId: {
      type: String,
      required: [true, 'senderId is required for chat message'],
      trim: true,
      maxlength: 32,
    },
    role: {
      type: String,
      enum: {
        values: ['user', 'assistant'],
        message: 'role must be either user or assistant',
      },
      required: [true, 'role is required for chat message'],
    },
    content: {
      type: String,
      required: [true, 'content is required for chat message'],
      trim: true,
      maxlength: [4000, 'content cannot exceed 4000 characters'],
    },
  },
  {
    timestamps: true,
  },
);

chatMessageSchema.index({ senderId: 1, createdAt: -1 });
chatMessageSchema.index({ createdAt: 1 }, { expires: '7d' });

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

export default ChatMessage;
