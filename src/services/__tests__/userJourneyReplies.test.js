import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatConfirmationMessage,
  formatSavedMessage,
} from '../draft/DraftFormatter.js';
import { formatGreetingReply, formatWelcomeMessage } from '../../whatsapp/services/welcomeFormatter.js';

test('formatGreetingReply gives a warm greeting with concrete next steps', () => {
  const reply = formatGreetingReply();

  assert.match(reply, /Hello/i);
  assert.match(reply, /bookkeeping/i);
  assert.match(reply, /Paid 15,000 for repairs at Flat 2/);
  assert.match(reply, /Monthly statement for Flat 2/);
  assert.equal(reply, formatWelcomeMessage());
});

test('formatConfirmationMessage describes an expense draft clearly', () => {
  const reply = formatConfirmationMessage({
    type: 'expense',
    amount: 15000,
    category: 'repairs',
    propertyName: 'Flat 2',
    transactionDate: new Date('2026-07-27T12:00:00Z'),
  });

  assert.equal(
    reply,
    "I've drafted an expense of ₦15,000 for repairs at Flat 2. Reply YES to save it, or tell me what to change.",
  );
});

test('formatConfirmationMessage describes an income draft clearly', () => {
  const reply = formatConfirmationMessage({
    type: 'income',
    amount: 200000,
    propertyName: 'Flat 2',
    transactionDate: new Date('2026-07-27T12:00:00Z'),
  });

  assert.equal(
    reply,
    "I've drafted an income entry of ₦200,000 for Flat 2. Reply YES to save it.",
  );
});

test('formatSavedMessage confirms exactly what was saved', () => {
  const reply = formatSavedMessage({
    type: 'expense',
    amount: 15000,
    category: 'repairs',
    propertyName: 'Flat 2',
    transactionDate: new Date('2026-07-27T12:00:00Z'),
  });

  assert.match(reply, /^Saved: Expense ₦15,000 for repairs at Flat 2 on \d{1,2} Jul 2026\.$/);
});
