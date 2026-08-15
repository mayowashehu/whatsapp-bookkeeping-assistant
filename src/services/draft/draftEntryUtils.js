export function toPlainDraftEntry(draftEntry) {
  if (!draftEntry) return {};
  if (typeof draftEntry.toObject === 'function') {
    return draftEntry.toObject();
  }
  return { ...draftEntry };
}

export default {
  toPlainDraftEntry,
};
