export function extractPropertyId(draftEntry) {
  if (!draftEntry) return null;
  return draftEntry.property && typeof draftEntry.property === 'object' && draftEntry.property._id
    ? draftEntry.property._id
    : draftEntry.property;
}

export function buildEntryPayloadFromDraft(draftEntry, confirmedAt = new Date(), senderId) {
  if (!draftEntry) {
    throw new Error('draftEntry is required for confirmation');
  }
  if (!senderId) {
    throw new Error('senderId is required for confirmation');
  }

  const propertyId = extractPropertyId(draftEntry);

  return {
    senderId,
    type: draftEntry.type,
    property: propertyId,
    amount: draftEntry.amount,
    category: draftEntry.type === 'income' ? null : draftEntry.category,
    description: draftEntry.description || '',
    sourceText: draftEntry.sourceText,
    transactionDate: draftEntry.transactionDate,
    confirmedAt,
    status: 'confirmed',
  };
}

export default {
  extractPropertyId,
  buildEntryPayloadFromDraft,
};