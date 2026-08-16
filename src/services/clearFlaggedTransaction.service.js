import Entry from '../models/Entry.js';
import PendingFlagClear from '../models/PendingFlagClear.js';
import {
  extractSearchCriteria,
  findConfirmedMatches,
  buildTransactionPreview,
  buildTransactionSnapshot,
  buildCandidateList,
  buildCandidatePreview,
  narrowCandidatesByText,
} from './transactionLookup.js';
import { card, bullet } from '../utils/waFormat.js';

// Task 3.3 — the "I checked it, it's fine" half of the flag flow from 3.2.
// Not every flagged transaction needs an edit — sometimes a second look
// confirms it was right all along, and there needs to be a way to say so
// without going through editConfirmedTransaction.service.js's change
// flow. Clearing never touches amount/property/category/type — it only
// turns flaggedForReview back off, same "ask before acting" shape as every
// other pending-state flow in this app. flagNote/flaggedAt are left in
// place afterwards as a record of the last reason raised (see Entry.js).
//
// Follow-up fix: an ambiguous match now persists its candidate list (see
// PendingFlagClear.js / transactionLookup.js's narrowCandidatesByText) so
// a reply like "the one from August 1st" or "1" resolves it, instead of
// requiring the whole request to be restated with more detail.

function createDefaultRepositories() {
  return {
    entryRepository: {
      async findFlaggedMatches({ senderId, amount, propertyId, limit = 6 }) {
        return findConfirmedMatches({ senderId, amount, propertyId, extraMatch: { flaggedForReview: true }, limit });
      },
      async clearFlagById(entryId) {
        return Entry.findByIdAndUpdate(entryId, { flaggedForReview: false }, { new: true })
          .populate('property', 'name')
          .lean();
      },
    },
    pendingClearRepository: {
      async create(record) {
        return PendingFlagClear.create(record);
      },
      async findByFromNumber(fromNumber) {
        return PendingFlagClear.findOne({ fromNumber }).lean();
      },
      async updateCandidates(fromNumber, changes) {
        return PendingFlagClear.findOneAndUpdate({ fromNumber }, changes, { new: true }).lean();
      },
      async deleteByFromNumber(fromNumber) {
        return PendingFlagClear.deleteOne({ fromNumber });
      },
    },
  };
}

export function createClearFlaggedTransactionService({ entryRepository, pendingClearRepository } = {}) {
  const repositories = {
    entryRepository: entryRepository || createDefaultRepositories().entryRepository,
    pendingClearRepository: pendingClearRepository || createDefaultRepositories().pendingClearRepository,
  };

  async function handleClearRequest({ text, fromNumber, senderId, knownProperties = [] }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const { amount, propertyResolution } = extractSearchCriteria(text, knownProperties);

    if (propertyResolution.status === 'ambiguous') {
      const names = propertyResolution.candidates.map((candidate) => candidate.name).join(', ');
      return {
        state: 'AMBIGUOUS_PROPERTY',
        replyText: card('⚠️', 'Multiple Properties Match', [`That property name matches more than one: ${names}.`], 'Resend naming the exact property.'),
        entry: null,
      };
    }

    const propertyId = propertyResolution.status === 'matched' ? propertyResolution.property.id : null;

    if (amount === null && !propertyId) {
      const matches = await repositories.entryRepository.findFlaggedMatches({ senderId, amount: null, propertyId: null, limit: 6 });
      if (matches.length === 1) {
        return startConfirmation(matches[0], fromNumber, senderId, repositories);
      }
      if (matches.length > 1) {
        return startDisambiguation(matches, fromNumber, senderId, repositories);
      }
      return {
        state: 'NEEDS_DETAILS',
        replyText: card('🚩', 'Need More Detail', ['To clear a flag, include the amount and/or property.'], 'e.g. "Clear the flag on the 20,000 repairs payment for Flat 2."'),
        entry: null,
      };
    }

    const matches = await repositories.entryRepository.findFlaggedMatches({ senderId, amount, propertyId, limit: 6 });

    if (matches.length === 0) {
      return {
        state: 'NO_MATCH',
        replyText: card('🔍', 'No Match Found', ["I couldn't find a flagged transaction matching that."], 'Say "show my flagged transactions" to see what\u2019s currently flagged.'),
        entry: null,
      };
    }

    if (matches.length > 1) {
      return startDisambiguation(matches, fromNumber, senderId, repositories);
    }

    return startConfirmation(matches[0], fromNumber, senderId, repositories);
  }

  async function handleDisambiguation({ text, fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingClear = await repositories.pendingClearRepository.findByFromNumber(fromNumber);
    if (!pendingClear || pendingClear.entryId) {
      return { state: 'NO_PENDING_CLEAR', replyText: card('⚠️', 'Nothing Pending', ['I do not have a pending flag-clear request to narrow down.']), entry: null };
    }

    const { matched, candidates } = narrowCandidatesByText(pendingClear.candidates, text);

    if (matched) {
      await repositories.pendingClearRepository.updateCandidates(fromNumber, { entryId: matched.entryId, candidates: [] });
      return {
        state: 'AWAITING_CLEAR_CONFIRMATION',
        replyText: card('🚩', 'Clear This Flag?', [buildCandidatePreview(matched)], 'Reply YES to clear the flag, or NO to leave it flagged.'),
        entry: null,
      };
    }

    if (candidates.length !== pendingClear.candidates.length) {
      await repositories.pendingClearRepository.updateCandidates(fromNumber, { candidates });
      const lines = candidates.slice(0, 5).map((candidate) => bullet(buildCandidatePreview(candidate))).join('\n');
      return { state: 'AMBIGUOUS_MATCH', replyText: card('🔍', 'Narrowed Down', [lines], 'Still more than one — which one do you mean?'), entry: null };
    }

    return {
      state: 'AMBIGUOUS_MATCH',
      replyText: card('🔍', 'Still Not Sure', ['I couldn\u2019t tell which one you mean.'], 'Try the date, a word from the description, or say "1", "2", etc.'),
      entry: null,
    };
  }

  async function handleConfirmation({ fromNumber, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const pendingClear = await repositories.pendingClearRepository.findByFromNumber(fromNumber);
    if (!pendingClear) {
      return { state: 'NO_PENDING_CLEAR', replyText: card('⚠️', 'Nothing Pending', ['I do not have a pending flag-clear request to confirm.']), entry: null };
    }
    if (!pendingClear.entryId) {
      return { state: 'NEEDS_SELECTION', replyText: card('🔍', 'Which One?', ['Reply with the date, a word from the description, or which one.']), entry: null };
    }

    const entry = await repositories.entryRepository.clearFlagById(pendingClear.entryId);
    await repositories.pendingClearRepository.deleteByFromNumber(fromNumber);

    return {
      state: 'CLEARED',
      replyText: card('✅', 'Flag Cleared', entry ? [buildTransactionPreview(entry)] : [], 'It\u2019s back to a normal confirmed entry.'),
      entry,
    };
  }

  async function handleCancellation({ fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingClear = await repositories.pendingClearRepository.findByFromNumber(fromNumber);
    if (!pendingClear) {
      return { state: 'NO_PENDING_CLEAR', replyText: card('⚠️', 'Nothing Pending', ['I do not have a pending flag-clear request to cancel.']), entry: null };
    }

    await repositories.pendingClearRepository.deleteByFromNumber(fromNumber);
    return { state: 'CANCELLED', replyText: card('🚫', 'Cancelled', ['Left the flag as it was.']), entry: null };
  }

  return { handleClearRequest, handleDisambiguation, handleConfirmation, handleCancellation };
}

async function startConfirmation(entry, fromNumber, senderId, repositories) {
  const preview = buildTransactionPreview(entry);
  const snapshot = buildTransactionSnapshot(entry);

  await repositories.pendingClearRepository.create({
    fromNumber,
    senderId,
    entryId: entry._id,
    candidates: [],
    entrySnapshot: snapshot,
  });

  return {
    state: 'AWAITING_CLEAR_CONFIRMATION',
    replyText: card('🚩', 'Clear This Flag?', [preview], 'Reply YES to clear the flag, or NO to leave it flagged.'),
    entry: null,
  };
}

async function startDisambiguation(matches, fromNumber, senderId, repositories) {
  const candidates = buildCandidateList(matches);
  const lines = candidates.slice(0, 5).map((candidate) => bullet(buildCandidatePreview(candidate))).join('\n');
  const moreNote = candidates.length > 5 ? `\n_...and ${candidates.length - 5} more._` : '';

  await repositories.pendingClearRepository.create({
    fromNumber,
    senderId,
    entryId: null,
    candidates,
    entrySnapshot: {},
  });

  return {
    state: 'AMBIGUOUS_MATCH',
    replyText: card('🔍', 'Multiple Matches', [lines + moreNote], 'Which one do you mean? Reply with the date, a word from the description, or which one.'),
    entry: null,
  };
}

export const clearFlaggedTransactionService = createClearFlaggedTransactionService();

export default clearFlaggedTransactionService;
