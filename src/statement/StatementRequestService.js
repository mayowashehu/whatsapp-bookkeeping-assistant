import { formatLagosMonthYear } from '../utils/dateFormatter.js';
import { deleteTempPdfFile } from '../pdf/tempPdf.js';
import { deliverStatementPdf } from '../whatsapp/delivery/deliverStatementPdf.js';
import { sendWhatsAppText } from '../whatsapp/services/whatsappSend.service.js';
import { createStatementManager } from './StatementManager.js';
import {
  interpretStatementRequest,
  buildClarificationQuestion,
} from './StatementRequestInterpreter.js';
import PendingStatement from '../models/PendingStatement.js';
import * as defaultDraftRepository from '../services/draft/DraftRepository.js';

// Fix #1 (requested follow-up to Phase 6.1): previously every branch below
// purged ANY pending draft unconditionally, even a fully-formed one just
// sitting there waiting for "YES"/"CANCEL" — so asking for a statement
// while you had an unconfirmed entry silently destroyed it with no way to
// get it back.
//
// This only purges when the draft is genuinely unsafe to leave alone: one
// that is itself mid-clarification (clarification.awaiting === true, e.g.
// still waiting on "which property?"). That specific case has to stay a
// purge, not because the draft is unsafe to KEEP, but because of a routing
// order issue in messageHandlerShared.js — a draft's own
// "clarification.awaiting" check runs before the statement session gets a
// chance to see the next message at all, so leaving both a mid-clarification
// draft AND a mid-clarification statement request alive at once would mean
// the user's answer to the statement's question ("Flat 2, July 2026") gets
// swallowed as an answer to the draft's question instead, permanently
// stalling the statement flow. A plain PENDING_CONFIRMATION draft (not
// awaiting clarification) doesn't have that collision, so it's left intact.
export async function purgeDraftIfUnsafeToKeep(DraftRepository, fromNumber) {
  const draft = await DraftRepository.findPendingDraftByFromNumber(fromNumber).catch(() => null);
  if (draft?.clarification?.awaiting) {
    await DraftRepository.deletePendingDraft(fromNumber).catch(() => {});
  }
}

export function createStatementRequestService(deps = {}) {
  const statementManager = deps.statementManager || createStatementManager();
  const deliverPdf = deps.deliverPdf || deliverStatementPdf;
  const interpret = deps.interpret || interpretStatementRequest;
  const deletePdf = deps.deletePdf || deleteTempPdfFile;
  const DraftRepository = deps.draftRepository || defaultDraftRepository;
  // Fire-and-forget interim ack. sendWhatsAppText already returns a
  // {success, error} shape instead of throwing for operational failures,
  // so this is safe to await without a try/catch of its own — the call
  // site below still wraps it in .catch() to guard against a thrown
  // network/DNS-level error that never makes it into that return shape.
  const sendInterimMessage = deps.sendInterimMessage || ((to, body) => sendWhatsAppText(to, body));

  async function handleStatementRequest(input) {
    if (!input.senderId) {
      throw new Error('senderId is required');
    }
    const fromNumber = input.phoneNumber || input.fromNumber;

    let pendingState = await PendingStatement.findOne({ fromNumber: String(fromNumber) });
    const knownProperties = input.knownProperties || [];
    const referenceDate = input.referenceDate || new Date();

    let year, month, property;

    if (pendingState) {
      // See purgeDraftIfUnsafeToKeep above — no longer an unconditional purge.
      await purgeDraftIfUnsafeToKeep(DraftRepository, fromNumber);

      // Re-parse the NEW message: it might supply the property, the
      // month/year, or (if the user just answers "Flat 2, July 2026" in
      // one go) both at once. Whatever it supplies wins; anything it
      // doesn't mention falls back to what was already resolved on a
      // previous turn. This is the piece that was missing before: the old
      // code assumed the ONLY thing that could ever still be missing on a
      // follow-up turn was the property, so a property-known/period-missing
      // case (e.g. "Statement for Flat 2" with no month) had nowhere to
      // persist the resolved property and crashed instead of asking again.
      const freshInterpretation = interpret(input.text, { knownProperties, referenceDate });

      if (freshInterpretation.propertyStatus === 'ambiguous' && freshInterpretation.propertyCandidates?.length > 1) {
        const names = freshInterpretation.propertyCandidates.map((p) => p.name).join(' or ');
        return {
          replyText: `Which property did you mean: ${names}?`,
          status: 'clarification',
        };
      }

      property =
        freshInterpretation.propertyStatus === 'matched'
          ? freshInterpretation.property
          : pendingState.propertyId
            ? { id: String(pendingState.propertyId), name: pendingState.propertyName }
            : null;

      // Property still unresolved after considering both the stored state
      // and this turn's text — surface the same friendly recovery message
      // used on the very first turn (scenario L), not a duplicate string.
      if (!property && freshInterpretation.propertyStatus === 'none' && freshInterpretation.unmatchedProperty) {
        return {
          replyText: buildClarificationQuestion({
            missingFields: ['property'],
            propertyStatus: 'none',
            unmatchedProperty: freshInterpretation.unmatchedProperty,
            knownProperties,
          }),
          status: 'property_not_found',
        };
      }

      month = freshInterpretation.month || pendingState.month || null;
      year = freshInterpretation.year || pendingState.year || null;

      const stillMissing = [];
      if (!property) stillMissing.push('property');
      if (!month) stillMissing.push('month');
      if (!year) stillMissing.push('year');

      if (stillMissing.length > 0) {
        await PendingStatement.findOneAndUpdate(
          { fromNumber: String(fromNumber) },
          {
            senderId: input.senderId,
            propertyId: property?.id || null,
            propertyName: property?.name || null,
            year,
            month,
            awaitingField: stillMissing[0],
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true },
        );
        return {
          replyText: buildClarificationQuestion({
            missingFields: stillMissing,
            propertyStatus: property ? 'matched' : 'missing',
            knownProperties,
          }),
          status: 'clarification',
        };
      }

      await PendingStatement.deleteOne({ fromNumber: String(fromNumber) });
    } else {
      const interpretation = interpret(input.text, { knownProperties, referenceDate });

      // K/L fix: previously this only persisted partial state and asked a
      // clarifying question when the PROPERTY was unresolved. If the
      // property matched but month/year didn't, execution fell straight
      // through to statement generation with year/month = null, which threw
      // inside resolveCalendarMonthBounds and surfaced as a generic "system
      // error" reply instead of a clarification question. Now ANY missing
      // field (property, month, or year, in any combination) is handled the
      // same way: persist what we know, ask about the rest.
      if (interpretation.missingFields.length > 0) {
        await Promise.all([
          purgeDraftIfUnsafeToKeep(DraftRepository, fromNumber),
          PendingStatement.findOneAndUpdate(
            { fromNumber: String(fromNumber) },
            {
              senderId: input.senderId,
              propertyId: interpretation.property?.id || null,
              propertyName: interpretation.property?.name || null,
              year: interpretation.year || null,
              month: interpretation.month || null,
              awaitingField: interpretation.missingFields[0],
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { upsert: true, new: true },
          ),
        ]);
        return {
          replyText: interpretation.clarificationQuestion,
          status: 'clarification',
        };
      }

      year = interpretation.year;
      month = interpretation.month;
      property = interpretation.property;
    }

    // See purgeDraftIfUnsafeToKeep above — no longer an unconditional purge.
    await purgeDraftIfUnsafeToKeep(DraftRepository, fromNumber);

    const periodLabel = formatLagosMonthYear(year, month);

    // K: acknowledge before the (potentially multi-second) generation step
    // instead of leaving the user with silence until the PDF lands.
    await sendInterimMessage(
      fromNumber,
      `Got it — generating the ${periodLabel} statement for ${property.name}. I'll send it shortly.`,
    ).catch(() => {});

    let pdfPath = null;

    try {
      const generated = await statementManager.generateMonthlyStatement({
        propertyId: property.id,
        year,
        month,
        senderId: input.senderId,
      });
      pdfPath = generated.pdfPath;

      const filename = `${slugify(property.name)}-${year}-${String(month).padStart(2, '0')}.pdf`;

      const delivery = await deliverPdf({
        phoneNumber: fromNumber,
        pdfPath,
        filename,
        caption: `${property.name} — ${periodLabel}`,
      });

      // BUGFIX: previously pdfPath was nulled here unconditionally, before
      // checking delivery.success. If deliverPdf resolved (didn't throw) but
      // reported success:false, the temp file was never cleaned up because
      // this line already zeroed out the reference. Now cleanup always runs
      // right after the delivery attempt, regardless of outcome.
      await deletePdf(pdfPath).catch(() => {});
      pdfPath = null;

      if (!delivery.success) {
        return {
          replyText:
            'I generated the statement but could not send the PDF. Please try again in a moment.',
          status: 'delivery_failed',
        };
      }

      return {
        replyText: `Your ${periodLabel} statement has been generated and sent.`,
        status: 'sent',
        statementSummary: generated.statementSummary,
      };
    } catch (err) {
      if (pdfPath) {
        await deletePdf(pdfPath).catch(() => {});
        pdfPath = null;
      }

      const message = err instanceof Error ? err.message : String(err);
      if (/property not found/i.test(message)) {
        return {
          replyText: `I could not find the property "${property?.name || 'unknown'}". Please check the name and try again.`,
          status: 'property_not_found',
        };
      }
      throw err;
    }
  }

  return {
    handleStatementRequest,
  };
}

function slugify(value) {
  return String(value || 'property')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'property';
}

const defaultService = createStatementRequestService();

export const handleStatementRequest = defaultService.handleStatementRequest;

export default {
  createStatementRequestService,
  handleStatementRequest,
};