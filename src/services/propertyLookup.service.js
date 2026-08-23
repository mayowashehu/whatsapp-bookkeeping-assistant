import Property from '../models/Property.js';

/**
 * Loads active properties for callers that need to supply knownProperties
 * to the pure TransactionParser (parser never queries MongoDB itself).
 * Includes a fallback net to catch records tied to 'pilot-user' if user-specific records are missing.
 *
 * @param {string} senderId - WhatsApp sender ID to filter properties
 * @returns {Promise<Array<{ id: string, name: string, aliases: string[], active: boolean }>>}
 */
export async function getKnownProperties(senderId) {
  if (!senderId) {
    throw new Error('senderId is required for getKnownProperties');
  }

  // 1. Try strict lookup for the specific senderId with case-insensitive collation
  let docs = await Property.find({ senderId, active: { $ne: false } })
    .collation({ locale: 'en', strength: 2 })
    .select('name aliases active')
    .lean();

  // 2. Fallback Net: If zero properties are found and senderId isn't already 'pilot-user',
  // check for legacy 'pilot-user' records to prevent parser lockups.
  if (docs.length === 0 && senderId !== 'pilot-user') {
    docs = await Property.find({ senderId: 'pilot-user', active: { $ne: false } })
      .collation({ locale: 'en', strength: 2 })
      .select('name aliases active')
      .lean();
  }

 // console.log('[DEBUG] getKnownProperties docs =', docs);

  // VULNERABILITY 4 FIX: Strip dangerously short/ambiguous aliases to prevent broad fuzzy collisions
  return docs.map((doc) => {
    const safeAliases = Array.isArray(doc.aliases)
      ? doc.aliases.filter(a => typeof a === 'string' && a.trim().length > 2)
      : [];

    return {
      id: String(doc._id),
      name: doc.name,
      aliases: safeAliases,
      active: doc.active !== false,
    };
  });
}

export default {
  getKnownProperties,
};