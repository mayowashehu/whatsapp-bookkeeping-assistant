import Entry from '../models/Entry.js';
import PendingDeletion from '../models/PendingDeletion.js';
import { formatNaira } from '../utils/currencyFormatter.js';
import { card } from '../utils/waFormat.js';

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function buildPreview(entry) {
  if (!entry) return null;
  const typeLabel = entry.type === 'income' ? 'income' : 'expense';
  const amount = formatNaira(entry.amount);
  const propertyName = entry.property?.name || entry.propertyName || 'Unknown property';
  const date = formatDate(entry.transactionDate || entry.confirmedAt);

  return `${typeLabel} *${amount}* for *${propertyName}*${date ? ` on ${date}` : ''}`;
}

function createDefaultRepositories() {
  return {
    entryRepository: {
      async findLatestConfirmedBySenderId(senderId) {
        // Bug fix (data-loss finding from manual WhatsApp test): "last
        // transaction" was sorted primarily by transactionDate, not by
        // when it was actually saved. A user can freely backdate an entry
        // (e.g. via a date correction — "edit the year to 2026" against an
        // older date), and once they do, "delete my last transaction"
        // would find and delete a DIFFERENT, unrelated entry that merely
        // happens to have a later calendar date, rather than the one the
        // user actually just entered. "Last" has to mean "most recently
        // saved" (createdAt), full stop — transactionDate is what the
        // transaction is ABOUT, not when the user acted on it.
        return Entry.findOne({ senderId, status: 'confirmed' })
          .sort({ createdAt: -1 })
          .populate('property', 'name')
          .lean();
      },
      async updateStatusById(entryId, status) {
        return Entry.findByIdAndUpdate(entryId, { status }, { new: true })
          .populate('property', 'name')
          .lean();
      },
    },
    pendingDeletionRepository: {
      async create(record) {
        return PendingDeletion.create(record);
      },
      async findByFromNumber(fromNumber) {
        return PendingDeletion.findOne({ fromNumber }).lean();
      },
      async deleteByFromNumber(fromNumber) {
        return PendingDeletion.deleteOne({ fromNumber });
      },
    },
  };
}

export function createDeleteLastTransactionService({ entryRepository, pendingDeletionRepository } = {}) {
  const repositories = {
    entryRepository: entryRepository || createDefaultRepositories().entryRepository,
    pendingDeletionRepository: pendingDeletionRepository || createDefaultRepositories().pendingDeletionRepository,
  };

  async function handleDeleteRequest({ fromNumber, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const latestEntry = await repositories.entryRepository.findLatestConfirmedBySenderId(senderId);

    if (!latestEntry) {
      return {
        state: 'NO_LAST_TRANSACTION',
        replyText: card('⚠️', 'Nothing to Delete', ['I could not find a confirmed transaction to delete.']),
        pendingDeletion: null,
        entry: null,
      };
    }

    const preview = buildPreview(latestEntry);

    await repositories.pendingDeletionRepository.create({
      fromNumber,
      senderId,
      entryId: latestEntry._id,
      entrySnapshot: {
        type: latestEntry.type,
        amount: latestEntry.amount,
        propertyName: latestEntry.property?.name || latestEntry.propertyName || 'Unknown property',
        description: latestEntry.description || '',
        transactionDate: latestEntry.transactionDate || latestEntry.confirmedAt,
      },
    });

    return {
      state: 'AWAITING_DELETION_CONFIRMATION',
      replyText: card('🗑️', 'Delete Last Transaction?', [`Most recent: ${preview}`], 'Reply YES to delete it, or NO to cancel.'),
      pendingDeletion: {
        fromNumber,
        senderId,
        entryId: latestEntry._id,
        entrySnapshot: {
          type: latestEntry.type,
          amount: latestEntry.amount,
          propertyName: latestEntry.property?.name || latestEntry.propertyName || 'Unknown property',
          description: latestEntry.description || '',
          transactionDate: latestEntry.transactionDate || latestEntry.confirmedAt,
        },
      },
      entry: null,
    };
  }

  async function handleConfirmation({ fromNumber, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const pendingDeletion = await repositories.pendingDeletionRepository.findByFromNumber(fromNumber);
    if (!pendingDeletion) {
      return {
        state: 'NO_LAST_TRANSACTION',
        replyText: card('⚠️', 'Nothing Pending', ['I do not have a pending deletion request to confirm.']),
        pendingDeletion: null,
        entry: null,
      };
    }

    const entry = await repositories.entryRepository.updateStatusById(pendingDeletion.entryId, 'deleted');
    await repositories.pendingDeletionRepository.deleteByFromNumber(fromNumber);

    return {
      state: 'DELETED',
      replyText: card('🗑️', 'Deleted', [`The most recent transaction was deleted${entry ? ' successfully' : ''}.`]),
      pendingDeletion: null,
      entry,
    };
  }

  async function handleCancellation({ fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingDeletion = await repositories.pendingDeletionRepository.findByFromNumber(fromNumber);
    if (!pendingDeletion) {
      return {
        state: 'NO_LAST_TRANSACTION',
        replyText: card('⚠️', 'Nothing Pending', ['I do not have a pending deletion request to cancel.']),
        pendingDeletion: null,
        entry: null,
      };
    }

    await repositories.pendingDeletionRepository.deleteByFromNumber(fromNumber);

    return {
      state: 'CANCELLED',
      replyText: card('🚫', 'Cancelled', ['Nothing was deleted.']),
      pendingDeletion: null,
      entry: null,
    };
  }

  return {
    handleDeleteRequest,
    handleConfirmation,
    handleCancellation,
  };
}

export const deleteLastTransactionService = createDeleteLastTransactionService();

export default deleteLastTransactionService;
