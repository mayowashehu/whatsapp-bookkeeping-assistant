import mongoose from 'mongoose';
import Entry from '../models/Entry.js';
import Property from '../models/Property.js';

/**
 * Read-only MongoDB access for statement generation.
 * Confirmed entries only. No calculations. No formatting.
 */
export async function findPropertyById(propertyId, senderId) {
  if (!propertyId || !senderId) {
    return null;
  }
  return Property.findOne({ _id: propertyId, senderId }).lean();
}

/**
 * @param {{ propertyId: string, startDate: Date, endDate: Date, senderId: string }} params
 * @returns {Promise<object[]>} Transactions sorted by transactionDate ascending
 */
export async function findConfirmedEntriesForPeriod({ propertyId, startDate, endDate, senderId }) {
  return Entry.find({
    status: 'confirmed',
    senderId,
    property: new mongoose.Types.ObjectId(String(propertyId)),
    transactionDate: {
      $gte: startDate,
      $lte: endDate,
    },
  })
    .sort({ transactionDate: 1, createdAt: 1 })
    .lean();
}

export default {
  findPropertyById,
  findConfirmedEntriesForPeriod,
};
