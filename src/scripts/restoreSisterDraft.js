/**
 * ONE-OFF SCRIPT — not part of the app's runtime pipeline.
 *
 * Context: on 24th Aug 2026, this sender's "Yes" got misrouted as
 * intent=AFFIRMATION instead of CONFIRMATION (bug now fixed), so her
 * gas-refill expense draft was silently dropped instead of confirmed.
 * Her resend then tripped a false-positive duplicate warning, and her
 * "No" to that closed out the session with nothing ever saved.
 *
 * This recreates that draft exactly as originally captured and sends a
 * one-time WhatsApp message explaining what happened, so she can
 * confirm/edit/cancel through the normal flow instead of having to
 * re-type the transaction from scratch.
 *
 * Run once: node src/scripts/restoreSisterDraft.js
 */

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);
import mongoose from 'mongoose';
import 'dotenv/config';
import env from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createPendingDraft, findPendingDraftByFromNumber, clearAllSessions } from '../services/draft/DraftRepository.js';
import { getKnownProperties } from '../services/propertyLookup.service.js';
import { sendWhatsAppText } from '../whatsapp/services/whatsappSend.service.js';
import { card } from '../utils/waFormat.js';

const FROM_NUMBER = '2347049201675';
//const FROM_NUMBER = '2348089759991';

// Parsed from her original message: "Gas refill: 12,200\nDate: 24th Aug 2026\nProperty: A7 downstairs"
const RAW_TEXT = 'Gas refill: 12,200\nDate: 24th Aug 2026\nProperty: A7 downstairs';
const PROPERTY_NAME = 'A7 downstairs';
const AMOUNT = 12200;
const CATEGORY = 'Gas refill';
const TRANSACTION_DATE = new Date('2026-08-24T00:00:00.000Z');

async function resolvePropertyId(fromNumber, propertyName) {
  const known = await getKnownProperties(fromNumber);
  const needle = propertyName.trim().toLowerCase();

  const match = known.find(
    (p) =>
      p.name.trim().toLowerCase() === needle ||
      p.aliases.some((a) => a.trim().toLowerCase() === needle),
  );

  if (!match) {
    throw new Error(
      `Could not resolve property "${propertyName}" for ${fromNumber}. ` +
        `Known properties: ${known.map((p) => p.name).join(', ') || '(none found)'}`,
    );
  }

  return match.id;
}

async function run() {
  await connectDatabase();

  try {
    const propertyId = await resolvePropertyId(FROM_NUMBER, PROPERTY_NAME);

    // Guard: don't clobber a draft she's actively mid-conversation on today.
    const existing = await findPendingDraftByFromNumber(FROM_NUMBER);
    if (existing) {
      console.log(
        `[restoreSisterDraft] ${FROM_NUMBER} already has an active pending draft — aborting to avoid overwriting it. ` +
          `Resolve or clear it manually first if you still want to proceed.`,
      );
      return;
    }

    await clearAllSessions(FROM_NUMBER);

    await createPendingDraft({
      fromNumber: FROM_NUMBER,
      draftEntry: {
        type: 'expense',
        property: propertyId,
        amount: AMOUNT,
        category: CATEGORY,
        description: CATEGORY,
        sourceText: RAW_TEXT,
        transactionDate: TRANSACTION_DATE,
      },
      clarification: { awaiting: false, missingFields: [], question: '' },
      queuedTransactions: [],
    });

    const message = card(
      '🔧',
      'Fixed & Ready',
      [
        'Your last transaction didn\u2019t go through because of a backend bug \u2014 that\u2019s sorted now:',
        '',
        `*Expense:* \u20a6${AMOUNT.toLocaleString('en-NG')}`,
        `*Property:* ${PROPERTY_NAME}`,
        `*Category:* ${CATEGORY}`,
        '*Date:* 24th Aug 2026',
      ],
      'Reply YES to save it, edit any detail, or CANCEL to discard.',
    );

    await sendWhatsAppText(FROM_NUMBER, message);
    console.log(`[restoreSisterDraft] Draft recreated and message sent to ${FROM_NUMBER}.`);
  } finally {
    await disconnectDatabase();
  }
}

run().catch((err) => {
  console.error('[restoreSisterDraft] Failed:', err);
  process.exitCode = 1;
});