import { applyCorrectionPatch } from './CorrectionProcessor.js';
import { buildEntryPayloadFromDraft, extractPropertyId } from './ConfirmationProcessor.js';
import { applyClarificationAnswer } from './ClarificationProcessor.js';
import * as DraftFormatter from './DraftFormatter.js';
import { toPlainDraftEntry } from './draftEntryUtils.js';
import * as defaultRepository from './DraftRepository.js';
import { mapParserDraftToDraftEntry } from './draftMapper.js';
import { generateClarificationQuestion } from '../../ai/parsing/ClarificationService.js';
import { missingFieldsForNormalizedTransaction } from '../../ai/parsing/TransactionParser.js';
import { buildDuplicateFingerprint, findLikelyDuplicateEntry as defaultFindLikelyDuplicateEntry } from '../duplicateDetection.service.js';
import { card } from '../../utils/waFormat.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

// How long a duplicate resend of the exact same transaction text is still
// treated as "probably the same attempt, not a deliberate second entry."
// Real-world testing showed AI calls can take anywhere from a few seconds to
// well over a minute (model fallback cascades); a user re-sending "Paid 50k
// for orchid" 10-60s after the first attempt, while it's still pending, is
// almost always impatience/uncertainty ("did that go through?"), not a
// request to log a second identical transaction.
const DUPLICATE_RESEND_WINDOW_MS = 2 * 60 * 1000;

function normalizeForComparison(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isLikelyDuplicateResend(existingDraft, parseResult) {
  if (!existingDraft) return false;

  const existingText = normalizeForComparison(existingDraft.draftEntry?.sourceText);
  const incomingText = normalizeForComparison(parseResult?.draft?.sourceText);
  if (!existingText || !incomingText || existingText !== incomingText) {
    return false;
  }

  const referenceTimestamp = existingDraft.updatedAt || existingDraft.createdAt;
  if (!referenceTimestamp) return false;
  const ageMs = Date.now() - new Date(referenceTimestamp).getTime();
  return ageMs >= 0 && ageMs <= DUPLICATE_RESEND_WINDOW_MS;
}

function validateDraftForCommit(draftEntry) {
  const missing = [];
  if (!draftEntry.type) missing.push('type');
  if (!draftEntry.amount) missing.push('amount');
  if (!draftEntry.property && !draftEntry.pendingNewPropertyName) missing.push('property');
  if (draftEntry.type === 'expense' && !draftEntry.category) missing.push('category');
  return missing;
}

function isDraftExpired(draft) {
  if (!draft?.createdAt) return false;
  return Date.now() - new Date(draft.createdAt).getTime() > DRAFT_TTL_MS;
}

async function getActiveDraft(fromNumber, DraftRepository) {
  const draft = await DraftRepository.findPendingDraftByFromNumber(fromNumber);
  if (!draft) return null;
  if (!isDraftExpired(draft)) return draft;
  await DraftRepository.deletePendingDraft(fromNumber);
  return null;
}

export function createDraftManager(deps = {}) {
  const DraftRepository = deps.repository || defaultRepository;
  const findLikelyDuplicateEntry = deps.findLikelyDuplicateEntry || defaultFindLikelyDuplicateEntry;

  async function purgeStatementSession(fromNumber) {
    if (typeof DraftRepository.clearStatementSession === 'function') {
      await DraftRepository.clearStatementSession(fromNumber).catch(() => {});
    }
  }

  async function purgeAllSessions(fromNumber) {
    if (typeof DraftRepository.clearAllSessions === 'function') {
      await DraftRepository.clearAllSessions(fromNumber).catch(() => {});
    } else {
      await DraftRepository.deletePendingDraft(fromNumber).catch(() => {});
    }
  }

  async function handleLogEntry({ fromNumber, parseResult, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    // FIX (Phase 1.4-pattern, 🔴 — confirmed live, Aug 7 follow-up
    // transcript): purgeStatementSession touches PendingStatement only;
    // getActiveDraft touches PendingDraft only — two independent
    // collections, no data dependency between them, previously run
    // sequentially for no reason. Same pattern applied consistently below
    // in handleClarification/handleConfirmation/handleCorrection.
    const [, existing] = await Promise.all([
      purgeStatementSession(fromNumber),
      getActiveDraft(fromNumber, DraftRepository),
    ]);

    if (isLikelyDuplicateResend(existing, parseResult)) {
      // Same text, same sender, same still-pending draft — this is almost
      // certainly a resend because the first attempt hadn't replied yet,
      // not a request to start over. Resurface exactly where things stand
      // instead of silently wiping progress and asking the same question
      // again.
      const stillWorkingNotice = "I'm still working on that one — no need to resend. ";
      if (existing.clarification?.awaiting) {
        return {
          state: 'AWAITING_CLARIFICATION',
          replyText: `${stillWorkingNotice}${existing.clarification.question}`,
          pendingDraft: existing,
          entry: null,
        };
      }

      const view = DraftFormatter.toDraftView(existing);
      return {
        state: 'PENDING_CONFIRMATION',
        replyText: `${stillWorkingNotice}${DraftFormatter.formatConfirmationMessage(view)}`,
        pendingDraft: existing,
        entry: null,
      };
    }

    // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live, REAL DATA LOSS):
    // a new, fully-formed transaction message arriving while an EARLIER
    // fully-formed draft was still sitting there awaiting YES/NO used to
    // unconditionally delete that earlier draft and replace it — the only
    // trace left behind was the one-line "Discarded previous incomplete
    // draft" notice. The user never got a chance to say "wait, save that
    // first" or "no, throw it away" — it was just gone, silently, the
    // moment the next message came in. Confirmed live: a ₦50,000 Flat 2
    // income draft, a ₦2,000,000 Orchid income draft, and a ₦77,000 Dubbai
    // expense draft were each wiped out this way in a single test session.
    //
    // Fix: an existing draft that is fully drafted and simply awaiting
    // confirmation is never discarded by a new incoming transaction message
    // anymore. Instead, the SAME mechanism already used for "two
    // transactions detected in one message" (queuedTransactions — see
    // handleConfirmation/handleCancel below) absorbs the new transaction(s):
    // the old draft stays exactly as it was, and the new one is appended to
    // its queue so it automatically surfaces the moment the old one is
    // confirmed or cancelled. Nothing the user described is ever thrown away
    // without an explicit YES/CANCEL from them.
    //
    // The one deliberate exception: if the existing draft is still mid-
    // CLARIFICATION (the bot asked "which property?" and never got a
    // straight answer), there's no safe, meaningful way to "queue behind"
    // a half-known transaction, and a fresh, fully-formed message is almost
    // always the user abandoning that clarification to describe something
    // new/corrected instead — so that specific case keeps the previous
    // discard-and-replace behavior (see the isExplicitTransaction fast-path
    // note in messageHandlerShared.js for the matching logic on that side).
    // Guard: only worth preserving-and-queuing if the new message actually
    // parsed into something with real content (an amount, at minimum) —
    // isExplicitTransaction already required verb+value wording in the raw
    // text to reach here, so a fully-empty parse is rare, but if it does
    // happen there's nothing meaningful to queue and falling through to the
    // normal discard-and-ask-for-clarification path below is safer than
    // silently queuing a blank entry behind the real draft.
    const incomingHasContent = Boolean(parseResult?.draft?.amount) || Boolean(parseResult?.draft?.type)
      || (Array.isArray(parseResult?.parsedTransactions) && parseResult.parsedTransactions.length > 0);

    if (existing && !existing.clarification?.awaiting && incomingHasContent && !isLikelyDuplicateResend(existing, parseResult)) {
      const incoming = Array.isArray(parseResult.parsedTransactions) && parseResult.parsedTransactions.length > 0
        ? parseResult.parsedTransactions
        : [parseResult.draft];
      const existingQueue = Array.isArray(existing.queuedTransactions) ? existing.queuedTransactions : [];

      await DraftRepository.updatePendingDraft({
        fromNumber,
        queuedTransactions: [...existingQueue, ...incoming],
      });

      const view = DraftFormatter.toDraftView(existing);
      const queuedNotice = incoming.length > 1
        ? `I\u2019ve queued the ${incoming.length} new transactions you just sent — I\u2019ll bring them up right after this one.`
        : `I\u2019ve queued the new transaction you just sent — I\u2019ll bring it up right after this one.`;

      return {
        state: 'PENDING_CONFIRMATION',
        replyText: card(
          '📝',
          'Pending Draft Still Waiting',
          [DraftFormatter.formatConfirmationMessage(view), '', queuedNotice],
          'Reply YES to save this one, or CANCEL to discard it and move to the next.',
        ),
        pendingDraft: existing,
        entry: null,
      };
    }

    let discardedNotice = '';

    if (existing) {
      await DraftRepository.deletePendingDraft(fromNumber);
      discardedNotice = '⚠️ *Discarded previous incomplete draft.*\n\n';
    }

    const draftEntry = mapParserDraftToDraftEntry(parseResult.draft);

    // FIX (W, follow-through): keep the rest of a multi-transaction batch
    // around so it isn't silently dropped once the first item is drafted.
    const queuedTransactions = Array.isArray(parseResult.parsedTransactions) && parseResult.parsedTransactions.length > 1
      ? parseResult.parsedTransactions.slice(1)
      : [];

    if (parseResult.clarificationRequired) {
      await DraftRepository.createPendingDraft({
        fromNumber,
        draftEntry,
        clarification: {
          awaiting: true,
          missingFields: parseResult.missingFields,
          question: parseResult.clarificationQuestion,
        },
        queuedTransactions,
      });

      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: `${discardedNotice}${parseResult.clarificationQuestion}`,
      };
    }

    await DraftRepository.createPendingDraft({
      fromNumber,
      draftEntry,
      queuedTransactions,
    });

    const populated = await getActiveDraft(fromNumber, DraftRepository);
    const view = DraftFormatter.toDraftView(populated);

    return {
      state: 'PENDING_CONFIRMATION',
      replyText: `${discardedNotice}${DraftFormatter.formatConfirmationMessage(view)}`,
      pendingDraft: populated,
      entry: null,
    };
  }

  async function handleClarification({ fromNumber, answer, knownProperties, referenceDate }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    // FIX (Phase 1.4-pattern, 🔴 — confirmed live): see handleLogEntry above.
    const [, draft] = await Promise.all([
      purgeStatementSession(fromNumber),
      getActiveDraft(fromNumber, DraftRepository),
    ]);
    if (!draft) {
      return {
        state: 'NO_DRAFT',
        replyText: DraftFormatter.formatNoDraftMessage(),
        pendingDraft: null,
        entry: null,
      };
    }

    if (!draft.clarification?.awaiting) {
      return {
        state: 'PENDING_CONFIRMATION',
        replyText: DraftFormatter.formatNoAwaitingClarificationMessage(),
        pendingDraft: draft,
        entry: null,
      };
    }

    const clarificationResult = applyClarificationAnswer(draft, answer, {
      knownProperties,
      referenceDate,
    });

    if (!clarificationResult.completed) {
      if (clarificationResult.error) {
        return {
          state: 'AWAITING_CLARIFICATION',
          replyText: clarificationResult.error,
        };
      }

      await DraftRepository.updatePendingDraft({
        fromNumber,
        draftEntry: clarificationResult.draftEntry,
        clarification: clarificationResult.clarification,
      });

      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: clarificationResult.clarification.question || "Could you please provide more details?",
      };
    }

    const updatedDraft = await DraftRepository.updatePendingDraft({
      fromNumber,
      draftEntry: clarificationResult.draftEntry,
      clarification: clarificationResult.clarification,
    });

    const view = DraftFormatter.toDraftView(updatedDraft);
    return {
      state: 'PENDING_CONFIRMATION',
      replyText: DraftFormatter.formatConfirmationMessage(view),
      pendingDraft: updatedDraft,
      entry: null,
    };
  }

  async function handleConfirmation({ fromNumber, senderId, knownProperties = [] }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    // FIX (Phase 1.4-pattern, 🔴 — confirmed live, Aug 7 follow-up
    // transcript): "Yes" confirmations were measured taking 4.5-6.7s with
    // ZERO AI calls involved — this and the redundant deleteOne removed
    // from confirmDraftAtomically below (see DraftRepository.js) are why.
    // purgeStatementSession and getActiveDraft hit different collections
    // with no dependency between them; running them sequentially just
    // added one DB round-trip's worth of latency for nothing.
    const [, draft] = await Promise.all([
      purgeStatementSession(fromNumber),
      getActiveDraft(fromNumber, DraftRepository),
    ]);
    if (!draft) {
      return {
        state: 'NO_DRAFT',
        replyText: DraftFormatter.formatNoDraftMessage(),
        pendingDraft: null,
        entry: null,
      };
    }

    const missing = validateDraftForCommit(draft.draftEntry);
    if (missing.length > 0) {
      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: generateClarificationQuestion({ missingFields: missing }),
        pendingDraft: draft,
        entry: null,
      };
    }

    // Duplicate Detection (PROJECT_CONTEXT.md) — one extra confirmation
    // step when this draft's shape (type + property + amount) matches a
    // confirmed entry saved in the last 24 hours, UNLESS the user has
    // already been shown that exact warning and said YES anyway (tracked
    // by fingerprint on the draft — see PendingDraft.js). Runs after
    // clarification (no point warning about an incomplete draft) and
    // before the entry is actually built/saved below.
    const propertyId = extractPropertyId(draft.draftEntry);
    const fingerprint = buildDuplicateFingerprint({
      type: draft.draftEntry.type,
      propertyId,
      amount: draft.draftEntry.amount,
    });
    const alreadyWarned = fingerprint && draft.duplicateWarning?.warnedFingerprint === fingerprint;

    if (fingerprint && !alreadyWarned) {
      const duplicate = await findLikelyDuplicateEntry({
        senderId,
        type: draft.draftEntry.type,
        propertyId,
        amount: draft.draftEntry.amount,
      });

      if (duplicate) {
        const updatedDraft = await DraftRepository.setDuplicateWarning(fromNumber, fingerprint);
        const view = DraftFormatter.toDraftView(updatedDraft || draft);
        return {
          state: 'AWAITING_DUPLICATE_CONFIRMATION',
          replyText: DraftFormatter.formatDuplicateWarningMessage(view, duplicate),
          pendingDraft: updatedDraft || draft,
          entry: null,
        };
      }
    }

    const entryPayload = buildEntryPayloadFromDraft(draft.draftEntry, new Date(), senderId);
    let entry;

    try {
      entry = await DraftRepository.confirmDraftAtomically({
        fromNumber,
        entryPayload,
        draftEntry: draft.draftEntry,
        senderId,
      });
    } catch (err) {
      return {
        state: 'PENDING_CONFIRMATION',
        replyText: '⚠️ A concurrent update happened while saving. Your pending draft is still intact — reply *YES* to try saving again.',
        pendingDraft: draft,
        entry: null,
        error: err.message,
      };
    }

    const view = DraftFormatter.toDraftView(draft);
    const savedMessage = DraftFormatter.formatSavedMessage(view);

    // FIX (W, follow-through): the confirmed draft may have arrived with
    // more transactions queued up behind it (see handleLogEntry above). If
    // so, automatically turn the next one into its own new draft right now
    // instead of leaving the user to ask "what about the second one?" and
    // hit a dead-end "no pending transaction" reply — that exact gap was
    // found in live testing.
    const queue = Array.isArray(draft.queuedTransactions) ? draft.queuedTransactions : [];
    if (queue.length === 0) {
      return {
        state: 'SAVED',
        replyText: savedMessage,
        pendingDraft: null,
        entry,
      };
    }

    const [nextTx, ...remainingQueue] = queue;
    const nextDraftEntry = mapParserDraftToDraftEntry(nextTx);
    const nextMissing = missingFieldsForNormalizedTransaction(nextTx);
    const leadIn = DraftFormatter.formatQueuedTransactionLeadIn(nextTx, knownProperties);

    if (nextMissing.length > 0) {
      const nextQuestion = generateClarificationQuestion({ missingFields: nextMissing, draft: nextTx });
      await DraftRepository.createPendingDraft({
        fromNumber,
        draftEntry: nextDraftEntry,
        clarification: {
          awaiting: true,
          missingFields: nextMissing,
          question: nextQuestion,
        },
        queuedTransactions: remainingQueue,
      });

      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: `${savedMessage}\n\n${leadIn} ${nextQuestion}`,
        entry,
      };
    }

    await DraftRepository.createPendingDraft({
      fromNumber,
      draftEntry: nextDraftEntry,
      queuedTransactions: remainingQueue,
    });

    const populatedNext = await getActiveDraft(fromNumber, DraftRepository);
    const nextView = DraftFormatter.toDraftView(populatedNext);

    return {
      state: 'PENDING_CONFIRMATION',
      replyText: `${savedMessage}\n\n${leadIn}\n${DraftFormatter.formatConfirmationMessage(nextView)}`,
      pendingDraft: populatedNext,
      entry,
    };
  }

  async function handleCancel({ fromNumber, knownProperties = [] }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const draft = await getActiveDraft(fromNumber, DraftRepository);

    if (!draft) {
      await purgeAllSessions(fromNumber);
      return {
        state: 'NO_DRAFT',
        replyText: DraftFormatter.formatNoDraftMessage(),
        pendingDraft: null,
        entry: null,
      };
    }

    // FIX (§3d-ii, 🔴 — confirmed via live testing): cancelling item 1 of a
    // multi-transaction batch used to wipe the entire pending state via
    // purgeAllSessions with zero awareness of queuedTransactions (the field
    // that carries the rest of a batch — see handleLogEntry/handleConfirmation
    // above). handleConfirmation already checks the queue and automatically
    // advances to the next item after a successful save; handleCancel never
    // got the same treatment, so discarding item 1 silently discarded item 2
    // right along with it — confirmed live: after "Discard this" on a
    // 2-item batch, the ₦20,000 repairs item never surfaced again, and "Do
    // I have any pending entry?" came back empty.
    //
    // Mirrors handleConfirmation's queue-advance logic exactly (same
    // clarification-vs-ready branching, same lead-in formatting), just
    // triggered by a cancel instead of a save, and with "Discarded." as the
    // headline instead of "Saved."
    const queue = Array.isArray(draft.queuedTransactions) ? draft.queuedTransactions : [];

    if (queue.length === 0) {
      await purgeAllSessions(fromNumber);
      return {
        state: 'CANCELLED',
        replyText: DraftFormatter.formatCancelledMessage(),
        pendingDraft: null,
        entry: null,
      };
    }

    // Only item 1 goes away — clear its draft doc and any statement
    // session, but deliberately do NOT purge the whole pending state, since
    // we're about to seed a fresh draft for the next queued item below.
    await DraftRepository.deletePendingDraft(fromNumber);
    await purgeStatementSession(fromNumber);

    const discardedNotice = 'I\u2019ve discarded that item. Nothing was saved for it.';
    const [nextTx, ...remainingQueue] = queue;
    const nextDraftEntry = mapParserDraftToDraftEntry(nextTx);
    const nextMissing = missingFieldsForNormalizedTransaction(nextTx);
    const leadIn = DraftFormatter.formatQueuedTransactionLeadIn(nextTx, knownProperties);

    if (nextMissing.length > 0) {
      const nextQuestion = generateClarificationQuestion({ missingFields: nextMissing, draft: nextTx });
      await DraftRepository.createPendingDraft({
        fromNumber,
        draftEntry: nextDraftEntry,
        clarification: {
          awaiting: true,
          missingFields: nextMissing,
          question: nextQuestion,
        },
        queuedTransactions: remainingQueue,
      });

      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: `${discardedNotice}\n\n${leadIn} ${nextQuestion}`,
        entry: null,
      };
    }

    await DraftRepository.createPendingDraft({
      fromNumber,
      draftEntry: nextDraftEntry,
      queuedTransactions: remainingQueue,
    });

    const populatedNext = await getActiveDraft(fromNumber, DraftRepository);
    const nextView = DraftFormatter.toDraftView(populatedNext);

    return {
      state: 'PENDING_CONFIRMATION',
      replyText: `${discardedNotice}\n\n${leadIn}\n${DraftFormatter.formatConfirmationMessage(nextView)}`,
      pendingDraft: populatedNext,
      entry: null,
    };
  }

  async function handleCorrection({ fromNumber, patch, knownProperties, referenceDate }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    // FIX (Phase 1.4-pattern, 🔴 — confirmed live): see handleLogEntry above.
    const [, draft] = await Promise.all([
      purgeStatementSession(fromNumber),
      getActiveDraft(fromNumber, DraftRepository),
    ]);
    if (!draft) {
      return {
        state: 'NO_DRAFT',
        replyText: DraftFormatter.formatNoDraftMessage(),
        pendingDraft: null,
        entry: null,
      };
    }

    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return {
        state: 'PENDING_CONFIRMATION',
        replyText: DraftFormatter.formatCorrectionUnclearMessage(),
        pendingDraft: draft,
        entry: null,
      };
    }

    let targetDraftEntry = toPlainDraftEntry(draft.draftEntry);
    if (patch.action === 'remove' || patch.dropItem) {
      targetDraftEntry.amount = 0;
      targetDraftEntry.description = 'Cancelled item via correction';
    }

    const corrected = applyCorrectionPatch(targetDraftEntry, patch, {
      knownProperties,
      referenceDate,
    });

    if (corrected.clarificationRequired) {
      const updated = await DraftRepository.updatePendingDraft({
        fromNumber,
        draftEntry: corrected.draftEntry,
        clarification: {
          awaiting: true,
          missingFields: corrected.missingFields,
          question: corrected.clarificationQuestion,
        },
      });

      return {
        state: 'AWAITING_CLARIFICATION',
        replyText: corrected.clarificationQuestion,
        pendingDraft: updated,
        entry: null,
        missingFields: corrected.missingFields,
      };
    }

    const updated = await DraftRepository.updatePendingDraft({
      fromNumber,
      draftEntry: corrected.draftEntry,
      clarification: {
        awaiting: false,
        missingFields: [],
        question: '',
      },
    });

    const view = DraftFormatter.toDraftView(updated);

    // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): applyCorrectionPatch
    // (CorrectionProcessor.js) already computes a precise, human-readable
    // `changeSummary` of exactly what just changed (e.g. "the date to 1 Jan
    // 2020") — this used to be thrown away entirely, replying with the same
    // generic "I've drafted a[n] ... Reply YES" text regardless of whether
    // anything changed. Now leads with what changed, then the full draft
    // (which, per the DraftFormatter fix above, now also shows the date).
    const changeLine = corrected.changeSummary && corrected.changeSummary !== 'the draft'
      ? `Updated ${corrected.changeSummary}.\n`
      : '';

    return {
      state: 'PENDING_CONFIRMATION',
      replyText: `${changeLine}${DraftFormatter.formatConfirmationMessage(view)}`,
      pendingDraft: updated,
      entry: null,
      updated: true,
    };
  }

  return {
    handleLogEntry,
    handleClarification,
    handleConfirmation,
    handleCancel,
    handleCorrection,
  };
}

const defaultManager = createDraftManager();

export const handleLogEntry = defaultManager.handleLogEntry;
export const handleClarification = defaultManager.handleClarification;
export const handleConfirmation = defaultManager.handleConfirmation;
export const handleCancel = defaultManager.handleCancel;
export const handleCorrection = defaultManager.handleCorrection;

export default defaultManager;