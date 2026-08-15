import mongoose from 'mongoose';
import Entry from '../../models/Entry.js';
import PendingDraft from '../../models/PendingDraft.js';
import PendingStatement from '../../models/PendingStatement.js';
import Property from '../../models/Property.js';
import { ConcurrentUpdateError } from '../../errors/ConcurrentUpdateError.js';

function sanitizeDraftEntryType(original) {
  const draftEntry = original ? { ...original } : {};
  if (draftEntry.type) {
    draftEntry.type = String(draftEntry.type).toLowerCase();
  }

  if (draftEntry.property && typeof draftEntry.property === 'object') {
    draftEntry.property = draftEntry.property._id || draftEntry.property.id || draftEntry.property;
  }

  return draftEntry;
}

export async function clearStatementSession(fromNumber) {
  return PendingStatement.deleteOne({ fromNumber: String(fromNumber) });
}

export async function clearAllSessions(fromNumber, session = null) {
  const strFrom = String(fromNumber);
  const options = session ? { session } : {};

  return Promise.all([
    PendingDraft.deleteOne({ fromNumber: strFrom }, options),
    PendingStatement.deleteOne({ fromNumber: strFrom }, options),
  ]);
}

export async function findPendingDraftByFromNumber(fromNumber) {
  return PendingDraft.findOne({ fromNumber: String(fromNumber) })
    .populate('draftEntry.property')
    .exec();
}

export async function createPendingDraft({ fromNumber, draftEntry, clarification, queuedTransactions }) {
  const strFrom = String(fromNumber);
  const safeDraftEntry = sanitizeDraftEntryType(draftEntry);

  await clearStatementSession(strFrom).catch(() => {});

  return PendingDraft.create({
    fromNumber: strFrom,
    draftEntry: safeDraftEntry,
    clarification,
    queuedTransactions: Array.isArray(queuedTransactions) ? queuedTransactions : [],
  });
}

export async function updatePendingDraft({
  fromNumber,
  draftEntry,
  clarification,
  queuedTransactions,
}) {
  const update = {};

  if (draftEntry !== undefined) {
    update.draftEntry = sanitizeDraftEntryType(draftEntry);
  }

  if (clarification !== undefined) {
    update.clarification = clarification;
  }

  // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live, real data loss):
  // lets DraftManager.handleLogEntry append newly-described transaction(s)
  // onto an already-pending draft's queue instead of having nowhere to put
  // them except overwriting the draft outright — see handleLogEntry.
  if (queuedTransactions !== undefined) {
    update.queuedTransactions = Array.isArray(queuedTransactions) ? queuedTransactions : [];
  }

  return PendingDraft.findOneAndUpdate(
    { fromNumber: String(fromNumber) },
    { $set: update },
    {
      new: true,
      runValidators: true,
    },
  )
    .populate('draftEntry.property')
    .exec();
}

export async function deletePendingDraft(fromNumber, session = null) {
  const options = session ? { session } : {};
  return PendingDraft.deleteOne({ fromNumber: String(fromNumber) }, options);
}

// Duplicate Detection — records that the user has now been shown a
// duplicate warning for this exact draft shape (see PendingDraft.js /
// duplicateDetection.service.js). Deliberately does NOT touch draftEntry
// or clarification — this only ever runs right before a save attempt, not
// as part of the normal edit flow.
export async function setDuplicateWarning(fromNumber, warnedFingerprint) {
  return PendingDraft.findOneAndUpdate(
    { fromNumber: String(fromNumber) },
    { $set: { 'duplicateWarning.warnedFingerprint': warnedFingerprint } },
    { new: true },
  )
    .populate('draftEntry.property')
    .exec();
}

export async function confirmDraftAtomically({ fromNumber, entryPayload, draftEntry, senderId }) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let finalEntryPayload = { ...entryPayload };

    if (draftEntry?.pendingNewPropertyName) {
      const propertyName = draftEntry.pendingNewPropertyName.trim();

      const propertyDoc = await Property.findOneAndUpdate(
        { senderId, name: propertyName },
        { $setOnInsert: { senderId, name: propertyName, active: true } },
        { upsert: true, new: true, session }
      );

      finalEntryPayload.property = propertyDoc._id;
    }

    const [entry] = await Entry.create([finalEntryPayload], { session });

    const deleteResult = await PendingDraft.deleteOne(
      { fromNumber: String(fromNumber) },
      { session },
    );

    // FIX (Phase 1.4-pattern, 🔴 — confirmed live, Aug 7 follow-up
    // transcript): this used to also do PendingStatement.deleteOne here,
    // inside the transaction — a fully redundant extra round-trip.
    // confirmDraftAtomically has exactly one caller (DraftManager's
    // handleConfirmation), and that caller already calls
    // purgeStatementSession(fromNumber) — which does the identical
    // PendingStatement.deleteOne — moments before this function even
    // runs. Deleting something already deleted added a full sequential
    // network round-trip to every single "Yes" confirmation for zero
    // effect. If confirmDraftAtomically ever gets a second caller that
    // does NOT already clear the statement session first, this needs to
    // come back for that path specifically — not unconditionally here.
    if (deleteResult.deletedCount !== 1) {
      throw new ConcurrentUpdateError('Pending draft was not deleted during atomic confirmation.');
    }

    await session.commitTransaction();
    return entry;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

export default {
  clearStatementSession,
  clearAllSessions,
  findPendingDraftByFromNumber,
  createPendingDraft,
  updatePendingDraft,
  deletePendingDraft,
  setDuplicateWarning,
  confirmDraftAtomically,
};