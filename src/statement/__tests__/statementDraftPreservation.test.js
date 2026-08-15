import test from 'node:test';
import assert from 'node:assert/strict';

import { purgeDraftIfUnsafeToKeep } from '../StatementRequestService.js';

function fakeRepo(initialDraft) {
  let draft = initialDraft;
  return {
    deleteCalls: 0,
    async findPendingDraftByFromNumber() {
      return draft;
    },
    async deletePendingDraft() {
      this.deleteCalls += 1;
      draft = null;
      return { deletedCount: 1 };
    },
  };
}

test('a fully-formed draft (not awaiting clarification) is left intact when a statement is requested', async () => {
  const repo = fakeRepo({
    fromNumber: '2348011111111',
    draftEntry: { amount: 20000, type: 'expense' },
    clarification: { awaiting: false, missingFields: [], question: '' },
  });

  await purgeDraftIfUnsafeToKeep(repo, '2348011111111');

  assert.equal(repo.deleteCalls, 0);
  const stillThere = await repo.findPendingDraftByFromNumber();
  assert.ok(stillThere, 'draft must survive a statement request');
});

test('a draft that is itself mid-clarification is still purged (avoids the statement-flow answer collision)', async () => {
  const repo = fakeRepo({
    fromNumber: '2348022222222',
    draftEntry: { amount: 20000, type: 'expense', property: null },
    clarification: { awaiting: true, missingFields: ['property'], question: 'Which property?' },
  });

  await purgeDraftIfUnsafeToKeep(repo, '2348022222222');

  assert.equal(repo.deleteCalls, 1);
  const stillThere = await repo.findPendingDraftByFromNumber();
  assert.equal(stillThere, null);
});

test('no-op (and no error) when there is no draft at all', async () => {
  const repo = fakeRepo(null);

  await purgeDraftIfUnsafeToKeep(repo, '2348033333333');

  assert.equal(repo.deleteCalls, 0);
});
