import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPendingDraftReminder,
  formatDraftClearedDuringContextSwitchNote,
} from '../draft/DraftFormatter.js';

test('formatPendingDraftReminder tells the user their draft is still waiting and how to act on it', () => {
  const note = formatPendingDraftReminder();
  assert.match(note, /unconfirmed entry/i);
  assert.match(note, /YES/);
  assert.match(note, /CANCEL/);
});

test('formatDraftClearedDuringContextSwitchNote never claims a draft is still pending', () => {
  const note = formatDraftClearedDuringContextSwitchNote();
  assert.match(note, /cleared/i);
  // Must not accidentally reuse language implying the draft still exists.
  assert.doesNotMatch(note, /still have/i);
  assert.doesNotMatch(note, /waiting/i);
});

test('the two notes are distinct strings (never accidentally aliased to the same text)', () => {
  assert.notEqual(formatPendingDraftReminder(), formatDraftClearedDuringContextSwitchNote());
});
