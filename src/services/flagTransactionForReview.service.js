import Entry from '../models/Entry.js';
import PendingFlagReview from '../models/PendingFlagReview.js';
import {
  extractSearchCriteria,
  findConfirmedMatches as findConfirmedMatchesShared,
  buildTransactionPreview,
  buildTransactionSnapshot,
  buildCandidateList,
  buildCandidatePreview,
  narrowCandidatesByText,
} from './transactionLookup.js';
import { formatNaira } from '../utils/currencyFormatter.js';

// Task 3.2 — "Define a path for editing an already-confirmed transaction."
//
// deleteLastTransaction.service.js only ever has to locate ONE entry: the
// most recent confirmed one. That's not available here — a mistake noticed
// "days later" is, by definition, not the last transaction anymore, and
// there is no dashboard or list UI to pick from (WhatsApp-first, no
// commands — see PROJECT_CONTEXT.md). So instead of an edit-in-place flow
// (which would require guessing which field is wrong, violating "never
// guess" / "always ask"), this gives the user a safe, honest minimum: find
// the specific confirmed entry the user describes (by amount and/or
// property), get an explicit YES before touching it, then mark it
// `flaggedForReview` with their note instead of silently failing or
// attempting an automatic edit. It stays fully intact in every query and
// statement — flagging never changes the numbers, it just leaves a visible
// trail.
//
// Task 3.3 adds the other end of that trail: `editConfirmedTransaction.service.js`
// actually corrects a flagged (or any confirmed) entry,
// `clearFlaggedTransaction.service.js` clears the flag once it's resolved,
// and the query subsystem gained FLAGGED_TRANSACTIONS so "show my flagged
// transactions" surfaces the list again — flagging used to be a dead end
// without it. This file's entry lookup was factored out into
// ../services/transactionLookup.js so all three share one search
// implementation.
//
// Same confirm-before-acting shape as deleteLastTransaction.service.js:
// find candidate(s) -> ask -> act only on explicit YES -> allow NO to
// cancel cleanly. Dependency-injected repositories for the same reason
// (testable without a live MongoDB connection).

function createDefaultRepositories() {
  return {
    entryRepository: {
      async findConfirmedMatches({ senderId, amount, propertyId, limit = 6 }) {
        return findConfirmedMatchesShared({ senderId, amount, propertyId, limit });
      },
      async setFlaggedById(entryId, { flagNote } = {}) {
        return Entry.findByIdAndUpdate(
          entryId,
          { flaggedForReview: true, flagNote: flagNote || null, flaggedAt: new Date() },
          { new: true },
        )
          .populate('property', 'name')
          .lean();
      },
    },
    pendingFlagRepository: {
      async create(record) {
        return PendingFlagReview.create(record);
      },
      async findByFromNumber(fromNumber) {
        return PendingFlagReview.findOne({ fromNumber }).lean();
      },
      async updateCandidates(fromNumber, changes) {
        return PendingFlagReview.findOneAndUpdate({ fromNumber }, changes, { new: true }).lean();
      },
      async deleteByFromNumber(fromNumber) {
        return PendingFlagReview.deleteOne({ fromNumber });
      },
    },
  };
}

export function createFlagTransactionForReviewService({ entryRepository, pendingFlagRepository } = {}) {
  const repositories = {
    entryRepository: entryRepository || createDefaultRepositories().entryRepository,
    pendingFlagRepository: pendingFlagRepository || createDefaultRepositories().pendingFlagRepository,
  };

  async function handleFlagRequest({ text, fromNumber, senderId, knownProperties = [] }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const note = String(text || '').trim();
    const { amount, propertyResolution } = extractSearchCriteria(text, knownProperties);

    if (propertyResolution.status === 'ambiguous') {
      const names = propertyResolution.candidates.map((candidate) => candidate.name).join(', ');
      return {
        state: 'AMBIGUOUS_PROPERTY',
        replyText: `That property name matches more than one property (${names}). Please resend, naming the exact property — for example "Flag the ${amount ? formatNaira(amount) : '20,000'} repairs payment for ${propertyResolution.candidates[0].name} for review."`,
        pendingFlag: null,
        entry: null,
      };
    }

    const propertyId = propertyResolution.status === 'matched' ? propertyResolution.property.id : null;

    if (amount === null && !propertyId) {
      return {
        state: 'NEEDS_DETAILS',
        replyText:
          'To flag a transaction for review, please include the amount and/or property, e.g. "Flag the 20,000 repairs payment for Flat 2 — wrong category."',
        pendingFlag: null,
        entry: null,
      };
    }

    const matches = await repositories.entryRepository.findConfirmedMatches({ senderId, amount, propertyId, limit: 6 });

    if (matches.length === 0) {
      return {
        state: 'NO_MATCH',
        replyText:
          "I couldn't find a confirmed transaction matching that. Double-check the amount and property, or mention roughly when it happened, and try again.",
        pendingFlag: null,
        entry: null,
      };
    }

    if (matches.length > 1) {
      const candidates = buildCandidateList(matches);
      const shown = candidates.slice(0, 5);
      const lines = shown.map((candidate) => `- ${buildCandidatePreview(candidate)}`).join('\n');
      const moreNote = candidates.length > shown.length ? `\n...and ${candidates.length - shown.length} more.` : '';

      await repositories.pendingFlagRepository.create({
        fromNumber,
        senderId,
        entryId: null,
        note,
        candidates,
        entrySnapshot: {},
      });

      return {
        state: 'AMBIGUOUS_MATCH',
        replyText: `I found more than one matching transaction:\n${lines}${moreNote}\nWhich one do you mean? Reply with the date, a word from the description, or which one (e.g. "1" or "the first one").`,
        pendingFlag: null,
        entry: null,
      };
    }

    const [entry] = matches;
    const preview = buildTransactionPreview(entry);
    const snapshot = buildTransactionSnapshot(entry);

    await repositories.pendingFlagRepository.create({
      fromNumber,
      senderId,
      entryId: entry._id,
      note,
      entrySnapshot: snapshot,
    });

    return {
      state: 'AWAITING_FLAG_CONFIRMATION',
      replyText: `I found this transaction: ${preview}. Reply YES to flag it for manual review, or NO to cancel.`,
      pendingFlag: { fromNumber, senderId, entryId: entry._id, note, entrySnapshot: snapshot },
      entry: null,
    };
  }

  async function handleDisambiguation({ text, fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingFlag = await repositories.pendingFlagRepository.findByFromNumber(fromNumber);
    if (!pendingFlag || pendingFlag.entryId) {
      return { state: 'NO_PENDING_FLAG', replyText: 'I do not have a pending flag request to narrow down.', pendingFlag: null, entry: null };
    }

    const { matched, candidates } = narrowCandidatesByText(pendingFlag.candidates, text);

    if (matched) {
      await repositories.pendingFlagRepository.updateCandidates(fromNumber, { entryId: matched.entryId, candidates: [] });
      return {
        state: 'AWAITING_FLAG_CONFIRMATION',
        replyText: `Got it: ${buildCandidatePreview(matched)}. Reply YES to flag it for manual review, or NO to cancel.`,
        pendingFlag: null,
        entry: null,
      };
    }

    if (candidates.length !== pendingFlag.candidates.length) {
      await repositories.pendingFlagRepository.updateCandidates(fromNumber, { candidates });
      const lines = candidates.slice(0, 5).map((candidate) => `- ${buildCandidatePreview(candidate)}`).join('\n');
      return {
        state: 'AMBIGUOUS_MATCH',
        replyText: `Narrowed it down, but still more than one:\n${lines}\nWhich one do you mean?`,
        pendingFlag: null,
        entry: null,
      };
    }

    return {
      state: 'AMBIGUOUS_MATCH',
      replyText: 'I still couldn\'t tell which one you mean. Try the date, a word from the description, or say "1", "2", etc.',
      pendingFlag: null,
      entry: null,
    };
  }

  async function handleConfirmation({ fromNumber, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const pendingFlag = await repositories.pendingFlagRepository.findByFromNumber(fromNumber);
    if (!pendingFlag) {
      return {
        state: 'NO_PENDING_FLAG',
        replyText: 'I do not have a pending flag request to confirm.',
        pendingFlag: null,
        entry: null,
      };
    }
    if (!pendingFlag.entryId) {
      return {
        state: 'NEEDS_SELECTION',
        replyText: 'Which transaction do you mean? Reply with the date, a word from the description, or which one.',
        pendingFlag: null,
        entry: null,
      };
    }

    const entry = await repositories.entryRepository.setFlaggedById(pendingFlag.entryId, {
      flagNote: pendingFlag.note || null,
    });
    await repositories.pendingFlagRepository.deleteByFromNumber(fromNumber);

    return {
      state: 'FLAGGED',
      replyText: `Flagged for manual review${entry ? `: ${buildTransactionPreview(entry)}` : ''}. It still counts exactly as before in your totals and statements — say "show my flagged transactions" any time to find it again, or "edit ..." to fix it now.`,
      pendingFlag: null,
      entry,
    };
  }

  async function handleCancellation({ fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingFlag = await repositories.pendingFlagRepository.findByFromNumber(fromNumber);
    if (!pendingFlag) {
      return {
        state: 'NO_PENDING_FLAG',
        replyText: 'I do not have a pending flag request to cancel.',
        pendingFlag: null,
        entry: null,
      };
    }

    await repositories.pendingFlagRepository.deleteByFromNumber(fromNumber);

    return {
      state: 'CANCELLED',
      replyText: 'I have not flagged anything.',
      pendingFlag: null,
      entry: null,
    };
  }

  return {
    handleFlagRequest,
    handleDisambiguation,
    handleConfirmation,
    handleCancellation,
  };
}

export const flagTransactionForReviewService = createFlagTransactionForReviewService();

// Kept for backward compatibility — existing callers/tests import
// extractFlagCriteria from this file. The implementation now lives in
// transactionLookup.js (shared with the edit/clear-flag flows).
export { extractSearchCriteria as extractFlagCriteria } from './transactionLookup.js';

export default flagTransactionForReviewService;
