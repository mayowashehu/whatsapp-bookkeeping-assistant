import User from '../../models/User.js';

const GREETING_KEYWORDS = ['hi', 'hello', 'hey', 'help', 'start', 'menu', 'ping', 'status', 'test'];
const GREETING_PATTERN = /^(hi|hello|hey|are you there|ping|status|test)$/i;
const MAX_GREETING_LENGTH = 15;

/**
 * Checks if a message text matches a greeting/help keyword.
 * Only triggers for:
 * - Exact matches (e.g., "hi", "hello")
 * - Short messages (<= 15 chars) that start with a greeting (e.g., "Hi!", "Hello there")
 * Does NOT trigger for long messages with greetings followed by transaction context (e.g., "Hi, paid 15k...")
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isGreetingMessage(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();

  if (GREETING_PATTERN.test(normalized)) {
    return true;
  }

  // Exact match
  if (GREETING_KEYWORDS.some(keyword => normalized === keyword)) {
    return true;
  }

  // Short message starting with greeting
  if (text.length <= MAX_GREETING_LENGTH) {
    return GREETING_KEYWORDS.some(keyword => normalized.startsWith(keyword));
  }

  return false;
}

/**
 * Checks if a user exists in the database by sender ID.
 * If not, creates a new user record.
 *
 * @param {string} senderId
 * @returns {Promise<{ isNewUser: boolean, user: any }>}
 */
export async function findOrCreateUser(senderId) {
  const existingUser = await User.findOne({ senderId });
  if (existingUser) {
    return { isNewUser: false, user: existingUser };
  }

  const newUser = new User({ senderId });
  await newUser.save();
  return { isNewUser: true, user: newUser };
}

export default {
  isGreetingMessage,
  findOrCreateUser,
};
