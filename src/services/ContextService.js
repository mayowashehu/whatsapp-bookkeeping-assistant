
import ChatMessage from '../models/ChatMessage.js';
import Entry from '../models/Entry.js';

/**
 * ContextService — fetches conversation and transaction history for context injection.
 */
export async function getConversationContext(senderId, limit = 5) {
  const messages = await ChatMessage.find({ senderId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  // Reverse to get chronological order
  return messages.reverse();
}

export async function getRecentTransactions(senderId, limit = 3) {
  const entries = await Entry.find({ senderId, status: 'confirmed' })
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(limit)
    .populate('property', 'name')
    .lean();
  return entries;
}

export async function saveChatMessage(senderId, role, content) {
  const message = new ChatMessage({
    senderId,
    role,
    content,
  });
  return await message.save();
}

export default {
  getConversationContext,
  getRecentTransactions,
  saveChatMessage,
};
