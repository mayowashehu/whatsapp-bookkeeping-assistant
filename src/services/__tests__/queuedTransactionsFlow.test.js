import test from 'node:test';
import assert from 'node:assert/strict';

import { createDraftManager } from '../draft/DraftManager.js';

// ---------------------------------------------------------------------------
// In-memory fake of DraftRepository.js's public surface. Mongo/mongoose are
// never touched — this lets the queue-advance state machine (handleConfirm/
// handleCancel walking through queuedTransactions) be exercised as a pure
// unit test, in line with Phase 6.5's ask to make this permanent regression
// coverage rather than "correct by accident."
// ---------------------------------------------------------------------------
function createFakeDraftRepository() {
  const drafts = new Map(); // fromNumber -> draft doc
  const statementSessions = new Set();
  const savedEntries = [];
  let nextEntryId = 1;

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  return {
    savedEntries,
    async clearStatementSession(fromNumber) {
      statementSessions.delete(String(fromNumber));
    },
    async clearAllSessions(fromNumber) {
      drafts.delete(String(fromNumber));
      statementSessions.delete(String(fromNumber));
    },
    async findPendingDraftByFromNumber(fromNumber) {
      const draft = drafts.get(String(fromNumber));
      return draft ? clone(draft) : null;
    },
    async createPendingDraft({ fromNumber, draftEntry, clarification, queuedTransactions }) {
      const doc = {
        fromNumber: String(fromNumber),
        draftEntry: clone(draftEntry) || {},
        clarification: clarification || { awaiting: false, missingFields: [], question: '' },
        queuedTransactions: Array.isArray(queuedTransactions) ? clone(queuedTransactions) : [],
        createdAt: new Date(),
        updatedAt: new Date(),
        duplicateWarning: {},
      };
      drafts.set(String(fromNumber), doc);
      return clone(doc);
    },
    async updatePendingDraft({ fromNumber, draftEntry, clarification }) {
      const key = String(fromNumber);
      const existing = drafts.get(key);
      if (!existing) return null;
      if (draftEntry !== undefined) existing.draftEntry = clone(draftEntry);
      if (clarification !== undefined) existing.clarification = clarification;
      existing.updatedAt = new Date();
      drafts.set(key, existing);
      return clone(existing);
    },
    async deletePendingDraft(fromNumber) {
      const existed = drafts.delete(String(fromNumber));
      return { deletedCount: existed ? 1 : 0 };
    },
    async setDuplicateWarning(fromNumber, warnedFingerprint) {
      const key = String(fromNumber);
      const existing = drafts.get(key);
      if (!existing) return null;
      existing.duplicateWarning = { warnedFingerprint };
      drafts.set(key, existing);
      return clone(existing);
    },
    async confirmDraftAtomically({ fromNumber, entryPayload }) {
      const key = String(fromNumber);
      const existing = drafts.get(key);
      if (!existing) {
        throw new Error('No pending draft to confirm (test fake).');
      }
      const entry = { _id: `entry-${nextEntryId++}`, ...entryPayload };
      savedEntries.push(entry);
      drafts.delete(key);
      return entry;
    },
  };
}

const KNOWN_PROPERTIES = [
  { id: '6a63b9ca8e81f864fde888b6', name: 'Orchid', aliases: [], active: true },
  { id: '6a6b6b6ee11e4ffb292fde0f', name: 'Flat 2', aliases: [], active: true },
];

// A realistic two-item TransactionParser result — both items fully
// resolved (no clarification needed for either), matching the shape
// TransactionParser.parseTransaction actually returns.
function twoItemParseResult() {
  return {
    classification: 'MULTIPLE',
    clarificationRequired: false,
    missingFields: [],
    clarificationQuestion: null,
    draft: {
      type: 'income',
      property: '6a6b6b6ee11e4ffb292fde0f',
      amount: 100000,
      category: null,
      description: 'Rent',
      transactionDate: 'today',
      sourceText: 'Received 100k rent for Flat 2 and paid 20k for repairs at Orchid',
      pendingNewPropertyName: null,
    },
    parsedTransactions: [
      {
        type: 'income',
        property: '6a6b6b6ee11e4ffb292fde0f',
        amount: 100000,
        category: null,
        description: 'Rent',
        transactionDate: 'today',
        sourceText: 'Received 100k rent for Flat 2 and paid 20k for repairs at Orchid',
        pendingNewPropertyName: null,
      },
      {
        type: 'expense',
        property: '6a63b9ca8e81f864fde888b6',
        amount: 20000,
        category: 'repairs',
        description: 'Repairs',
        transactionDate: 'today',
        sourceText: 'Received 100k rent for Flat 2 and paid 20k for repairs at Orchid',
        pendingNewPropertyName: null,
      },
    ],
  };
}

function buildManager() {
  const repository = createFakeDraftRepository();
  const manager = createDraftManager({
    repository,
    findLikelyDuplicateEntry: async () => null, // isolate queue logic from duplicate-detection
  });
  return { manager, repository };
}

test('queuedTransactions: handleLogEntry drafts the first item and queues the rest', async () => {
  const { manager, repository } = buildManager();

  const result = await manager.handleLogEntry({
    fromNumber: '2348011111111',
    senderId: '2348011111111',
    parseResult: twoItemParseResult(),
  });

  assert.equal(result.state, 'PENDING_CONFIRMATION');
  const stored = await repository.findPendingDraftByFromNumber('2348011111111');
  assert.equal(stored.draftEntry.amount, 100000);
  assert.equal(stored.queuedTransactions.length, 1);
  assert.equal(stored.queuedTransactions[0].amount, 20000);
  // Invariant: no transaction is saved without explicit confirmation.
  assert.equal(repository.savedEntries.length, 0);
});

test('queuedTransactions: confirming item 1 saves it and automatically advances to item 2', async () => {
  const { manager, repository } = buildManager();
  const fromNumber = '2348022222222';

  await manager.handleLogEntry({ fromNumber, senderId: fromNumber, parseResult: twoItemParseResult() });

  const confirmResult = await manager.handleConfirmation({
    fromNumber,
    senderId: fromNumber,
    knownProperties: KNOWN_PROPERTIES,
  });

  // Item 1 was actually saved as a confirmed Entry.
  assert.equal(repository.savedEntries.length, 1);
  assert.equal(repository.savedEntries[0].amount, 100000);

  // The state machine advanced straight to item 2 as a brand-new draft,
  // rather than leaving the user with a dead end.
  assert.equal(confirmResult.state, 'PENDING_CONFIRMATION');
  assert.match(confirmResult.replyText, /Saved/);
  assert.match(confirmResult.replyText, /second transaction/i);

  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  assert.ok(stored, 'a new draft for item 2 should now be pending');
  assert.equal(stored.draftEntry.amount, 20000);
  assert.equal(stored.queuedTransactions.length, 0);
});

test('queuedTransactions: confirming the final queued item leaves no draft behind (well-defined end state)', async () => {
  const { manager, repository } = buildManager();
  const fromNumber = '2348033333333';

  await manager.handleLogEntry({ fromNumber, senderId: fromNumber, parseResult: twoItemParseResult() });
  await manager.handleConfirmation({ fromNumber, senderId: fromNumber, knownProperties: KNOWN_PROPERTIES });

  const finalConfirm = await manager.handleConfirmation({
    fromNumber,
    senderId: fromNumber,
    knownProperties: KNOWN_PROPERTIES,
  });

  assert.equal(finalConfirm.state, 'SAVED');
  assert.equal(repository.savedEntries.length, 2);
  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  assert.equal(stored, null, 'no draft should remain once the whole batch is confirmed');
});

test('queuedTransactions: cancelling item 1 discards only that item and advances to item 2 (not the whole batch)', async () => {
  const { manager, repository } = buildManager();
  const fromNumber = '2348044444444';

  await manager.handleLogEntry({ fromNumber, senderId: fromNumber, parseResult: twoItemParseResult() });

  const cancelResult = await manager.handleCancel({ fromNumber, knownProperties: KNOWN_PROPERTIES });

  // Item 1 must never have been saved.
  assert.equal(repository.savedEntries.length, 0);
  assert.equal(cancelResult.state, 'PENDING_CONFIRMATION');
  assert.match(cancelResult.replyText, /discarded/i);
  assert.match(cancelResult.replyText, /second transaction/i);

  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  assert.ok(stored, 'item 2 should now be the active draft');
  assert.equal(stored.draftEntry.amount, 20000);
  assert.equal(stored.queuedTransactions.length, 0);
});

test('queuedTransactions: cancelling the last remaining item ends the session cleanly', async () => {
  const { manager, repository } = buildManager();
  const fromNumber = '2348055555555';

  await manager.handleLogEntry({ fromNumber, senderId: fromNumber, parseResult: twoItemParseResult() });
  await manager.handleCancel({ fromNumber, knownProperties: KNOWN_PROPERTIES }); // discards item 1, advances to item 2

  const finalCancel = await manager.handleCancel({ fromNumber, knownProperties: KNOWN_PROPERTIES });

  assert.equal(finalCancel.state, 'CANCELLED');
  assert.equal(repository.savedEntries.length, 0);
  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  assert.equal(stored, null);
});

// ---------------------------------------------------------------------------
// Additional QA invariants from the Phase 6 stress-test review, codified as
// permanent regression tests per 6.5.
// ---------------------------------------------------------------------------

test('invariant: at most one active draft session exists per user (a second log entry replaces, not appends)', async () => {
  const { manager, repository } = buildManager();
  const fromNumber = '2348066666666';

  await manager.handleLogEntry({
    fromNumber,
    senderId: fromNumber,
    parseResult: {
      classification: 'SINGLE',
      clarificationRequired: false,
      missingFields: [],
      clarificationQuestion: null,
      draft: {
        type: 'expense',
        property: '6a63b9ca8e81f864fde888b6',
        amount: 5000,
        category: 'diesel',
        description: 'Fuel',
        transactionDate: 'today',
        sourceText: 'Paid 5k for diesel at Orchid',
        pendingNewPropertyName: null,
      },
      parsedTransactions: [],
    },
  });

  await manager.handleLogEntry({ fromNumber, senderId: fromNumber, parseResult: twoItemParseResult() });

  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  // Exactly one draft doc exists for this user, and it reflects the SECOND
  // message, not a merge of both.
  assert.equal(stored.draftEntry.amount, 100000);
});

test('invariant: every user action ends in a well-defined state when there is no draft to act on', async () => {
  const { manager } = buildManager();
  const fromNumber = '2348077777777';

  const confirmResult = await manager.handleConfirmation({ fromNumber, senderId: fromNumber });
  assert.equal(confirmResult.state, 'NO_DRAFT');
  assert.ok(confirmResult.replyText);

  const cancelResult = await manager.handleCancel({ fromNumber });
  assert.equal(cancelResult.state, 'NO_DRAFT');
  assert.ok(cancelResult.replyText);

  const clarifyResult = await manager.handleClarification({ fromNumber, answer: 'Orchid', knownProperties: KNOWN_PROPERTIES });
  assert.equal(clarifyResult.state, 'NO_DRAFT');
  assert.ok(clarifyResult.replyText);

  const correctionResult = await manager.handleCorrection({ fromNumber, patch: { amount: 5000 }, knownProperties: KNOWN_PROPERTIES });
  assert.equal(correctionResult.state, 'NO_DRAFT');
  assert.ok(correctionResult.replyText);
});

test('invariant: a concurrent-update failure while saving is never reported as success', async () => {
  const repository = createFakeDraftRepository();
  // Force confirmDraftAtomically to fail the way a real concurrent update
  // would, without touching mongoose at all.
  repository.confirmDraftAtomically = async () => {
    throw new Error('Pending draft was not deleted during atomic confirmation.');
  };
  const manager = createDraftManager({ repository, findLikelyDuplicateEntry: async () => null });
  const fromNumber = '2348088888888';

  await manager.handleLogEntry({
    fromNumber,
    senderId: fromNumber,
    parseResult: {
      classification: 'SINGLE',
      clarificationRequired: false,
      missingFields: [],
      clarificationQuestion: null,
      draft: {
        type: 'expense',
        property: '6a63b9ca8e81f864fde888b6',
        amount: 5000,
        category: 'diesel',
        description: 'Fuel',
        transactionDate: 'today',
        sourceText: 'Paid 5k for diesel at Orchid',
        pendingNewPropertyName: null,
      },
      parsedTransactions: [],
    },
  });

  const result = await manager.handleConfirmation({ fromNumber, senderId: fromNumber, knownProperties: KNOWN_PROPERTIES });

  assert.notEqual(result.state, 'SAVED');
  assert.equal(repository.savedEntries.length, 0);
  assert.match(result.replyText, /concurrent update|try saving again/i);
  // The draft must still be intact so the user can just retry — recovery
  // without contacting support.
  const stored = await repository.findPendingDraftByFromNumber(fromNumber);
  assert.ok(stored, 'draft must survive a failed confirmation attempt');
});
