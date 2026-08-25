import PendingDraft from '../../models/PendingDraft.js';
import { sendWhatsAppText } from '../../whatsapp/services/whatsappSend.service.js';
import { toDraftView, formatConfirmationMessage } from './DraftFormatter.js';
import { withSenderLock } from '../../utils/concurrencyLocks.js';
import { card } from '../../utils/waFormat.js';

// PendingDraft.expiresAt has a 24h TTL that hard-deletes the draft (see
// models/PendingDraft.js). Reminding at 20h leaves a 4h buffer for the user
// to act on the nudge before the draft is gone for good — reminding right
// at 24h risks the TTL sweep beating the reminder send.
const REMINDER_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours

export async function checkAndRemindStaleDrafts() {
  try {
    const thresholdDate = new Date(Date.now() - REMINDER_THRESHOLD_MS);

    const staleDrafts = await PendingDraft.find({
      createdAt: { $lte: thresholdDate },
      reminderSent: { $ne: true },
    });

    if (!staleDrafts || staleDrafts.length === 0) {
      return;
    }

    console.log(`[DraftReminder] Found ${staleDrafts.length} stale draft(s) to check.`);

    for (const draft of staleDrafts) {
      const fromNumber = draft.fromNumber;

      // Wrap background processing per sender inside the mutex lock
      await withSenderLock(fromNumber, async () => {
        // Double-check state inside the lock (user might have confirmed/deleted during queueing)
        const currentDraft = await PendingDraft.findById(draft._id);
        if (!currentDraft || currentDraft.reminderSent) {
          return;
        }

        const view = toDraftView(currentDraft);

        // FIX (§10, 🟠): this used to call formatConfirmationMessage(view)
        // unconditionally for every stale draft. A draft that's stale
        // because the user never answered a clarification question (e.g.
        // "how much was paid?") has no amount yet — formatConfirmationMessage
        // calls formatNaira(draftView.amount), and formatNaira(undefined)
        // returns "₦0", so the reminder stated a fabricated, wrong amount
        // ("I've drafted an expense of ₦0 for repairs...") and invited
        // "Reply YES to save it" for a draft that genuinely isn't ready to
        // save. Now: if the draft is still mid-clarification, resend the
        // actual pending question instead of pretending there's a complete
        // entry to confirm.
        const isAwaitingClarification = Boolean(currentDraft.clarification?.awaiting);
        const reminderText = isAwaitingClarification
          ? `⏳ ${'*Draft Reminder*'}\n\nYou still have an unfinished entry — I'm waiting on one more detail:\n\n${currentDraft.clarification.question}`
          : card(
              '⏳',
              'Draft Reminder',
              ['You have an unconfirmed transaction waiting:', '', formatConfirmationMessage(view)],
              'Reply YES to save it, or CANCEL to discard.',
            );

        await sendWhatsAppText(fromNumber, reminderText);

        currentDraft.reminderSent = true;
        await currentDraft.save();
        console.log(`[DraftReminder] Sent reminder to ${fromNumber}`);
      });
    }
  } catch (err) {
    console.error('[DraftReminder] Error checking stale drafts:', err);
  }
}

export function startDraftReminderDaemon(intervalMinutes = 30) {
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`[DraftReminder] Daemon started. Polling every ${intervalMinutes} minutes.`);
  setInterval(checkAndRemindStaleDrafts, intervalMs);
}

export default {
  checkAndRemindStaleDrafts,
  startDraftReminderDaemon,
};