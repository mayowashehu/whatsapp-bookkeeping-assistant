import Entry from '../models/Entry.js';
import PendingEntryEdit from '../models/PendingEntryEdit.js';
import { buildCorrectionPatch, sanitizePatch } from './buildCorrectionPatch.js';
import { normalizeAmount, normalizeTransactionDate, resolveProperty } from '../ai/parsing/TransactionNormalizer.js';
import { formatNaira } from '../utils/currencyFormatter.js';
import {
  extractSearchCriteria,
  findConfirmedMatches,
  buildTransactionPreview,
  buildTransactionSnapshot,
  buildCandidateList,
  buildCandidatePreview,
  narrowCandidatesByText,
  formatDate,
} from './transactionLookup.js';

// Task 3.3 — the actual fix, once a transaction has been located (via
// flagTransactionForReview.service.js's search, or directly here). Three
// turns, same "find -> ask -> act only on explicit YES" shape as every
// other pending-state flow in this app, because an edit to a
// already-confirmed record is exactly the kind of thing that should never
// happen from a guess:
//
//   1. handleEditRequest   — locate the entry (amount/property, like the
//      flag flow), ask "what would you like to change?"
//   2. handleChangeRequest — parse the free-text change into a patch
//      (reuses buildCorrectionPatch, the same parser DraftManager uses for
//      draft corrections), preview old -> new, ask for YES/NO.
//   3. handleConfirmation  — apply it. Clears flaggedForReview if the
//      entry was flagged (the point of the edit was to resolve the flag),
//      and stamps editedAt so the record shows it was corrected after the
//      fact.
//
// Never applies a field the user didn't explicitly ask to change, and
// never invents a value it isn't confident about — an ambiguous property
// name or an unresolvable date stops and asks again rather than guessing.

const EDITABLE_FIELDS = ['type', 'amount', 'property', 'category', 'description', 'transactionDate'];

function createDefaultRepositories() {
  return {
    entryRepository: {
      async findConfirmedMatches({ senderId, amount, propertyId, limit = 6 }) {
        return findConfirmedMatches({ senderId, amount, propertyId, limit });
      },
      async findById(entryId) {
        return Entry.findById(entryId).populate('property', 'name').lean();
      },
      async applyPatchById(entryId, update) {
        const entry = await Entry.findByIdAndUpdate(entryId, update, { new: true, runValidators: true }).populate(
          'property',
          'name',
        );
        return entry ? entry.toObject() : null;
      },
    },
    pendingEditRepository: {
      async create(record) {
        return PendingEntryEdit.create(record);
      },
      async findByFromNumber(fromNumber) {
        return PendingEntryEdit.findOne({ fromNumber }).lean();
      },
      async updateStage(fromNumber, changes) {
        return PendingEntryEdit.findOneAndUpdate({ fromNumber }, changes, { new: true }).lean();
      },
      async deleteByFromNumber(fromNumber) {
        return PendingEntryEdit.deleteOne({ fromNumber });
      },
    },
  };
}

/**
 * Resolves a raw text patch (from buildCorrectionPatch) into concrete
 * values the Entry schema expects, plus a human-readable before/after line
 * per field. Stops at the first field it can't confidently resolve rather
 * than applying the rest and silently dropping one.
 */
function resolvePatch(rawPatch, snapshot, knownProperties, referenceDate) {
  const resolved = {};
  const changes = [];

  if (rawPatch.type !== undefined) {
    const type = String(rawPatch.type).trim().toLowerCase();
    if (type !== 'income' && type !== 'expense') {
      return { error: `"${rawPatch.type}" isn't income or expense.` };
    }
    resolved.type = type;
    changes.push(`Type: ${snapshot.type} → ${type}`);
  }

  if (rawPatch.amount !== undefined) {
    const amount = normalizeAmount(rawPatch.amount);
    if (amount === null || amount <= 0) {
      return { error: `I couldn't read "${rawPatch.amount}" as an amount.` };
    }
    resolved.amount = amount;
    changes.push(`Amount: ${formatNaira(snapshot.amount)} → ${formatNaira(amount)}`);
  }

  if (rawPatch.property !== undefined) {
    const propertyResolution = resolveProperty(rawPatch.property, knownProperties);
    if (propertyResolution.status !== 'matched') {
      const hint =
        propertyResolution.status === 'ambiguous'
          ? ` It matches more than one: ${propertyResolution.candidates.map((c) => c.name).join(', ')}.`
          : '';
      return { error: `I couldn't match "${rawPatch.property}" to one of your properties.${hint}` };
    }
    resolved.property = propertyResolution.property.id;
    changes.push(`Property: ${snapshot.propertyName} → ${propertyResolution.property.name}`);
  }

  if (rawPatch.category !== undefined) {
    const category = String(rawPatch.category).trim();
    resolved.category = category || null;
    changes.push(`Category: ${snapshot.category || '—'} → ${category || '—'}`);
  }

  if (rawPatch.description !== undefined) {
    resolved.description = String(rawPatch.description).trim();
    changes.push(`Description: ${snapshot.description || '—'} → ${resolved.description || '—'}`);
  }

  if (rawPatch.transactionDate !== undefined) {
    const ymd = normalizeTransactionDate(rawPatch.transactionDate, referenceDate);
    if (!ymd) {
      return { error: `I couldn't read "${rawPatch.transactionDate}" as a date.` };
    }
    resolved.transactionDate = new Date(`${ymd}T12:00:00.000Z`);
    changes.push(`Date: ${formatDate(snapshot.transactionDate)} → ${formatDate(resolved.transactionDate)}`);
  }

  // A type switch to expense with no category (given here or already on
  // the entry) can't be committed — the schema requires one. Ask up front
  // instead of letting mongoose validation reject it after confirmation.
  const nextType = resolved.type || snapshot.type;
  const nextCategory = resolved.category !== undefined ? resolved.category : snapshot.category;
  if (nextType === 'expense' && !nextCategory) {
    return { error: 'Switching to expense also needs a category — resend including e.g. "...and set the category to repairs."' };
  }
  if (nextType === 'income' && resolved.category === undefined) {
    // Income requires category to be null; clear it automatically if the
    // entry is moving from expense to income and the user didn't already
    // address it.
    resolved.category = null;
  }

  return { patch: resolved, changes };
}

export function createEditConfirmedTransactionService({ entryRepository, pendingEditRepository } = {}) {
  const repositories = {
    entryRepository: entryRepository || createDefaultRepositories().entryRepository,
    pendingEditRepository: pendingEditRepository || createDefaultRepositories().pendingEditRepository,
  };

  async function handleEditRequest({ text, fromNumber, senderId, knownProperties = [] }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const { amount, propertyResolution } = extractSearchCriteria(text, knownProperties);

    if (propertyResolution.status === 'ambiguous') {
      const names = propertyResolution.candidates.map((candidate) => candidate.name).join(', ');
      return {
        state: 'AMBIGUOUS_PROPERTY',
        replyText: `That property name matches more than one property (${names}). Please resend, naming the exact property.`,
        entry: null,
      };
    }

    const propertyId = propertyResolution.status === 'matched' ? propertyResolution.property.id : null;

    if (amount === null && !propertyId) {
      return {
        state: 'NEEDS_DETAILS',
        replyText:
          'To edit a transaction, please include the amount and/or property, e.g. "Edit the 20,000 repairs payment for Flat 2."',
        entry: null,
      };
    }

    const matches = await repositories.entryRepository.findConfirmedMatches({ senderId, amount, propertyId, limit: 6 });

    if (matches.length === 0) {
      return {
        state: 'NO_MATCH',
        replyText: "I couldn't find a confirmed transaction matching that. Double-check the amount and property, and try again.",
        entry: null,
      };
    }

    if (matches.length > 1) {
      const candidates = buildCandidateList(matches);
      const shown = candidates.slice(0, 5);
      const lines = shown.map((candidate) => `- ${buildCandidatePreview(candidate)}`).join('\n');
      const moreNote = candidates.length > shown.length ? `\n...and ${candidates.length - shown.length} more.` : '';

      await repositories.pendingEditRepository.create({
        fromNumber,
        senderId,
        entryId: null,
        stage: 'AWAITING_SELECTION',
        patch: {},
        candidates,
        entrySnapshot: {},
      });

      return {
        state: 'AMBIGUOUS_MATCH',
        replyText: `I found more than one matching transaction:\n${lines}${moreNote}\nWhich one do you mean? Reply with the date, a word from the description, or which one (e.g. "1" or "the first one").`,
        entry: null,
      };
    }

    const [entry] = matches;
    const snapshot = buildTransactionSnapshot(entry);

    await repositories.pendingEditRepository.create({
      fromNumber,
      senderId,
      entryId: entry._id,
      stage: 'AWAITING_CHANGES',
      patch: {},
      entrySnapshot: snapshot,
    });

    return {
      state: 'AWAITING_CHANGES',
      replyText: `Found it: ${buildTransactionPreview(entry)}. What would you like to change? (amount, property, category, income/expense, date, or description) Or reply CANCEL to stop.`,
      entry: null,
    };
  }

  async function handleDisambiguation({ text, fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingEdit = await repositories.pendingEditRepository.findByFromNumber(fromNumber);
    if (!pendingEdit || pendingEdit.stage !== 'AWAITING_SELECTION') {
      return { state: 'NO_PENDING_EDIT', replyText: 'I do not have a pending edit to narrow down.', entry: null };
    }

    const { matched, candidates } = narrowCandidatesByText(pendingEdit.candidates, text);

    if (matched) {
      const entry = await repositories.entryRepository.findById(matched.entryId);
      const snapshot = entry ? buildTransactionSnapshot(entry) : matched;
      await repositories.pendingEditRepository.updateStage(fromNumber, {
        entryId: matched.entryId,
        stage: 'AWAITING_CHANGES',
        candidates: [],
        entrySnapshot: snapshot,
      });
      return {
        state: 'AWAITING_CHANGES',
        replyText: `Got it: ${buildCandidatePreview(matched)}. What would you like to change? (amount, property, category, income/expense, date, or description) Or reply CANCEL to stop.`,
        entry: null,
      };
    }

    if (candidates.length !== pendingEdit.candidates.length) {
      await repositories.pendingEditRepository.updateStage(fromNumber, { candidates });
      const lines = candidates.slice(0, 5).map((candidate) => `- ${buildCandidatePreview(candidate)}`).join('\n');
      return { state: 'AMBIGUOUS_MATCH', replyText: `Narrowed it down, but still more than one:\n${lines}\nWhich one do you mean?`, entry: null };
    }

    return {
      state: 'AMBIGUOUS_MATCH',
      replyText: 'I still couldn\'t tell which one you mean. Try the date, a word from the description, or say "1", "2", etc.',
      entry: null,
    };
  }

  async function handleChangeRequest({ text, fromNumber, knownProperties = [], referenceDate = new Date() }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingEdit = await repositories.pendingEditRepository.findByFromNumber(fromNumber);
    if (!pendingEdit) {
      return { state: 'NO_PENDING_EDIT', replyText: 'I do not have a pending edit to continue.', entry: null };
    }
    if (pendingEdit.stage === 'AWAITING_SELECTION') {
      return { state: 'NEEDS_SELECTION', replyText: 'Which transaction do you mean? Reply with the date, a word from the description, or which one.', entry: null };
    }

    const { patch: rawPatch, parseResult: correctionParseResult } = await buildCorrectionPatch(text, {
      knownProperties,
      context: 'confirmed-entry',
      // Fix (follow-up to Phase 6.3): same reasoning as the draft-side
      // callers — lets a partial date edit combine with the confirmed
      // entry's existing date instead of the AI guessing the rest.
      currentTransactionDate: pendingEdit.entrySnapshot?.transactionDate,
      // Fix (manual WhatsApp testing): same mismatch guard as the
      // draft-side callers — see buildCorrectionPatch.js.
      currentDraftSummary: buildTransactionPreview(pendingEdit.entrySnapshot),
    });

    if (correctionParseResult?.possibleMismatch) {
      const currentSummary = buildTransactionPreview(pendingEdit.entrySnapshot);
      return {
        state: 'AWAITING_CHANGES',
        replyText: `That sounds like it might be about a different transaction${correctionParseResult.mismatchNote ? ` (${correctionParseResult.mismatchNote})` : ''} than the one you're editing (${currentSummary}). Try again more specifically, or reply CANCEL to stop.`,
        entry: null,
      };
    }

    const clean = sanitizePatch(rawPatch);

    if (Object.keys(clean).length === 0) {
      return {
        state: 'AWAITING_CHANGES',
        replyText:
          'I couldn\'t tell what to change. Try something like "change the amount to 25,000" or "change the category to maintenance". Or reply CANCEL to stop.',
        entry: null,
      };
    }

    const { patch, changes, error } = resolvePatch(clean, pendingEdit.entrySnapshot, knownProperties, referenceDate);
    if (error) {
      return { state: 'AWAITING_CHANGES', replyText: `${error} Try again, or reply CANCEL to stop.`, entry: null };
    }

    await repositories.pendingEditRepository.updateStage(fromNumber, { stage: 'AWAITING_CONFIRMATION', patch });

    return {
      state: 'AWAITING_CONFIRMATION',
      replyText: `Here's the change:\n${changes.map((line) => `- ${line}`).join('\n')}\nReply YES to save, or NO to cancel.`,
      entry: null,
    };
  }

  async function handleConfirmation({ fromNumber, senderId }) {
    if (!fromNumber) throw new Error('fromNumber is required');
    if (!senderId) throw new Error('senderId is required');

    const pendingEdit = await repositories.pendingEditRepository.findByFromNumber(fromNumber);
    if (!pendingEdit || pendingEdit.stage !== 'AWAITING_CONFIRMATION') {
      return { state: 'NO_PENDING_EDIT', replyText: 'I do not have a pending edit to confirm.', entry: null };
    }

    const update = {
      ...Object.fromEntries(Object.entries(pendingEdit.patch || {}).filter(([key]) => EDITABLE_FIELDS.includes(key))),
      editedAt: new Date(),
      // The point of an edit is to resolve whatever prompted it — including
      // a flag raised on this entry (if any). See Entry.js: clearing here
      // still leaves flagNote/flaggedAt in place as history.
      flaggedForReview: false,
    };

    try {
      const entry = await repositories.entryRepository.applyPatchById(pendingEdit.entryId, update);
      await repositories.pendingEditRepository.deleteByFromNumber(fromNumber);

      return {
        state: 'EDITED',
        replyText: `Saved${entry ? `: ${buildTransactionPreview(entry)}` : ''}. Your totals and statements now reflect this update.`,
        entry,
      };
    } catch (err) {
      await repositories.pendingEditRepository.deleteByFromNumber(fromNumber);
      return {
        state: 'EDIT_FAILED',
        replyText: `I couldn't save that change (${err.message}). Please start the edit again.`,
        entry: null,
      };
    }
  }

  async function handleCancellation({ fromNumber }) {
    if (!fromNumber) throw new Error('fromNumber is required');

    const pendingEdit = await repositories.pendingEditRepository.findByFromNumber(fromNumber);
    if (!pendingEdit) {
      return { state: 'NO_PENDING_EDIT', replyText: 'I do not have a pending edit to cancel.', entry: null };
    }

    await repositories.pendingEditRepository.deleteByFromNumber(fromNumber);
    return { state: 'CANCELLED', replyText: 'No changes made.', entry: null };
  }

  return { handleEditRequest, handleDisambiguation, handleChangeRequest, handleConfirmation, handleCancellation };
}

export const editConfirmedTransactionService = createEditConfirmedTransactionService();

export default editConfirmedTransactionService;
