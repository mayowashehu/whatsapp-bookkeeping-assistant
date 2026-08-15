import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeleteLastTransactionService } from '../deleteLastTransaction.service.js';

function createEntry(entryOverrides = {}) {
  return {
    _id: 'entry-1',
    senderId: 'sender-1',
    type: 'expense',
    amount: 15000,
    category: 'repairs',
    description: 'Plumbing fix',
    property: { name: 'Flat 2' },
    transactionDate: new Date('2026-07-27T12:00:00.000Z'),
    confirmedAt: new Date('2026-07-27T12:00:00.000Z'),
    status: 'confirmed',
    ...entryOverrides,
  };
}

test('requests confirmation before deleting the most recent confirmed transaction', async () => {
  const latestEntry = createEntry();
  const pendingDeletionRepository = {
    findByFromNumber: async () => null,
    create: async (record) => record,
    deleteByFromNumber: async () => true,
  };
  const entryRepository = {
    findLatestConfirmedBySenderId: async () => latestEntry,
    updateStatusById: async () => ({ ...latestEntry, status: 'deleted' }),
  };

  const service = createDeleteLastTransactionService({
    entryRepository,
    pendingDeletionRepository,
  });

  const result = await service.handleDeleteRequest({ fromNumber: '2348000000000', senderId: 'sender-1' });

  assert.equal(result.state, 'AWAITING_DELETION_CONFIRMATION');
  assert.match(result.replyText, /Reply YES to delete it/i);
  assert.match(result.replyText, /Flat 2/i);
  assert.ok(result.pendingDeletion);
});

test('deletes the confirmed entry when confirmation is received', async () => {
  const latestEntry = createEntry();
  const pendingDeletionRepository = {
    findByFromNumber: async () => ({
      fromNumber: '2348000000000',
      entryId: 'entry-1',
      entrySnapshot: {
        type: 'expense',
        amount: 15000,
        propertyName: 'Flat 2',
        description: 'Plumbing fix',
        transactionDate: '2026-07-27T12:00:00.000Z',
      },
    }),
    create: async () => null,
    deleteByFromNumber: async () => true,
  };
  const entryRepository = {
    findLatestConfirmedBySenderId: async () => latestEntry,
    updateStatusById: async (id) => ({ _id: id, status: 'deleted' }),
  };

  const service = createDeleteLastTransactionService({
    entryRepository,
    pendingDeletionRepository,
  });

  const result = await service.handleConfirmation({ fromNumber: '2348000000000', senderId: 'sender-1' });

  assert.equal(result.state, 'DELETED');
  assert.match(result.replyText, /deleted/i);
  assert.equal(result.entry?.status, 'deleted');
});
