import DeferredMessage from '../../models/DeferredMessage.js';
import { processMessageContent } from '../../whatsapp/services/messageHandlerShared.js';
import { sendWhatsAppText } from '../../whatsapp/services/whatsappSend.service.js';
import { withSenderLock } from '../../utils/concurrencyLocks.js';
import {
  createDeferredMessageService,
  buildDeferredAckReply,
  buildQueuedBehindReply,
  buildAlreadySavedReply,
} from './DeferredMessageService.js';

const ACTIVE = ['pending', 'processing'];

/** Thin MongoDB adapter. All queue *logic* lives in DeferredMessageService.js. */
const mongoRepo = {
  insert: (doc) => DeferredMessage.create(doc),
  hasActive: async (senderId) =>
    Boolean(await DeferredMessage.exists({ senderId, status: { $in: ACTIVE } })),
  listActive: (senderId) =>
    DeferredMessage.find({ senderId, status: { $in: ACTIVE } }).lean(),
  listDueSenders: (now) =>
    DeferredMessage.distinct('senderId', { status: 'pending', nextAttemptAt: { $lte: now } }),
  listPending: (senderId) =>
    DeferredMessage.find({ senderId, status: 'pending' }).sort({ createdAt: 1 }).lean(),
  claim: (id) =>
    DeferredMessage.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'processing', processingStartedAt: new Date() } },
      { new: true },
    ).lean(),
  complete: (id) => DeferredMessage.updateOne({ _id: id }, { $set: { status: 'done' } }),
  reschedule: (id, { attempts, nextAttemptAt, lastError }) =>
    DeferredMessage.updateOne(
      { _id: id },
      { $set: { status: 'pending', attempts, nextAttemptAt, lastError } },
    ),
  fail: (id, { attempts, lastError }) =>
    DeferredMessage.updateOne({ _id: id }, { $set: { status: 'failed', attempts, lastError } }),
  // Items stuck in 'processing' (e.g. the process was killed mid-turn by a Render deploy)
  recoverStale: (cutoff) =>
    DeferredMessage.updateMany(
      { status: 'processing', processingStartedAt: { $lt: cutoff } },
      { $set: { status: 'pending', nextAttemptAt: new Date() } },
    ),
};

const service = createDeferredMessageService({
  repo: mongoRepo,
  processMessage: processMessageContent,
  sendText: sendWhatsAppText,
  withLock: withSenderLock,
});

export const enqueueDeferredMessage = service.enqueue;
export const hasPendingDeferred = service.hasPending;
export const isDeferredDuplicate = service.isDuplicateOfActive;
export const processDueDeferredMessages = service.processDue;
export { buildDeferredAckReply, buildQueuedBehindReply, buildAlreadySavedReply };

let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await service.processDue();
  } catch (err) {
    console.error('[DeferredMessage] tick failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startDeferredMessageDaemon(intervalSeconds = 15) {
  if (timer) return;
  timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref?.();
  // Pick up anything left over from before a restart/deploy/spin-down soon after boot.
  setTimeout(tick, 5000).unref?.();
  console.log(`[DeferredMessage] Daemon started. Polling every ${intervalSeconds}s.`);
}

export default { enqueueDeferredMessage, hasPendingDeferred, startDeferredMessageDaemon };
