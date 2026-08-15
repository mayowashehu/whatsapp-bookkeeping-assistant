import PendingDraft from '../../models/PendingDraft.js';
import { sendWhatsAppText } from '../../whatsapp/services/whatsappSend.service.js';
import { toDraftView, formatConfirmationMessage, formatClarificationMessage } from './DraftFormatter.js';
import { withSenderLock } from '../../utils/concurrencyLocks.js';

const REMINDER_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

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
        const reminderBody = isAwaitingClarification
          ? `Still waiting on this: ${formatClarificationMessage(currentDraft.clarification.question)}`
          : formatConfirmationMessage(view);
        const reminderFooter = isAwaitingClarification
          ? '\n\nReply with the missing detail, or *CANCEL* to discard.'
          : '\n\nReply *YES* to save it, or *CANCEL* to discard.';
        const reminderText = `⏳ *Draft Reminder*\n\nYou have an unconfirmed transaction waiting:\n\n${reminderBody}${reminderFooter}`;

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