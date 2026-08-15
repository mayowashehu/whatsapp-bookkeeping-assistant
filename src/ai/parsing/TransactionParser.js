import { extractTransactionFields } from './AiParsingService.js';
import { isAiUnavailableError } from '../aiFallback.js';
import { generateClarificationQuestion } from './ClarificationService.js';
import { validateParsingOutput, isBelowConfidenceFloor, normalizeParsingConfidence, hasHedgeLanguage } from './ParsingValidator.js';
import env from '../../config/env.js';
import {
  normalizeTransactionFields,
  getPropertyId,
  sortMissingFieldsByPriority,
  inferTypeFromText,
} from './TransactionNormalizer.js';

function finalizePropertyResolution(normalized, knownProperties) {
  if (!normalized?.draft?.property) return;

  const raw = normalized.draft.property;
  const asString = String(raw);

  if (knownProperties.some((property) => getPropertyId(property) === asString)) {
    normalized.draft.property = asString;
    return;
  }

  const byName = knownProperties.find(
    (property) => property?.name && property.name.toLowerCase() === asString.trim().toLowerCase(),
  );
  if (byName) {
    normalized.draft.property = getPropertyId(byName);
    return;
  }

  normalized.draft.pendingNewPropertyName = asString;
  normalized.draft.property = null;
}

function emptyDraft(sourceText) {
  return {
    type: null,
    property: null,
    amount: null,
    category: null,
    description: '',
    transactionDate: null,
    sourceText: sourceText || '',
    pendingNewPropertyName: null,
  };
}

export async function parseTransaction(text, options = {}) {
  const sourceText = typeof text === 'string' ? text.trim() : '';
  const knownProperties = Array.isArray(options.knownProperties) ? options.knownProperties : [];
  const knownPropertyNames = knownProperties
    .map((property) => (typeof property === 'string' ? property : property?.name))
    .filter(Boolean);
  const senderId = options.senderId;

  if (!sourceText) {
    return buildResult({
      classification: 'INCOMPLETE',
      parsedTransactions: [],
      draft: emptyDraft(sourceText),
      clarificationRequired: true,
      missingFields: ['type', 'property', 'amount', 'transactionDate'],
      clarificationQuestion: generateClarificationQuestion({ missingFields: ['type'] }),
      mirrorClarificationPrompt: null,
      reasoning: 'Empty input.',
    });
  }

  const queryRegex = /^(how much|what is|show me|total|summarize|did i|have i|list|report|statement|query)\b/i;
  const isLikelyQuery = queryRegex.test(sourceText) || sourceText.endsWith('?');

  if (isLikelyQuery) {
    return buildResult({
      classification: 'INCOMPLETE',
      parsedTransactions: [],
      draft: emptyDraft(sourceText),
      clarificationRequired: true,
      missingFields: ['type', 'property', 'amount'], 
      clarificationQuestion: "⚠️ It looks like you're asking a question or requesting a report, but the transaction logger caught it. Please type *Cancel* to clear this, then ask your question again.",
      mirrorClarificationPrompt: null,
      reasoning: 'Input intercepted as a ledger query bypassing the router.',
    });
  }

  let raw;
  try {
    raw = await extractTransactionFields(sourceText, {
      knownPropertyNames,
      aiService: options.aiService,
      senderId,
    });
  } catch (err) {
    if (isAiUnavailableError(err)) {
      return buildResult({
        classification: 'INCOMPLETE',
        parsedTransactions: [],
        draft: emptyDraft(sourceText),
        clarificationRequired: false,
        missingFields: [],
        clarificationQuestion: null,
        mirrorClarificationPrompt: null,
        reasoning: err.message,
        aiUnavailable: true,
      });
    }
    return buildResult({
      classification: 'INCOMPLETE',
      parsedTransactions: [],
      draft: emptyDraft(sourceText),
      clarificationRequired: true,
      missingFields: ['type', 'property', 'amount', 'transactionDate'],
      clarificationQuestion: generateClarificationQuestion({ missingFields: ['type'] }),
      mirrorClarificationPrompt: null,
      reasoning: `AI extraction failed: ${err.message}`,
    });
  }

  if (raw && typeof raw === 'object' && raw.intent === 'CLARIFY_PROPERTY') {
    const validation = validateParsingOutput(raw);
    if (!validation.ok) {
      const reason = [...validation.structuralErrors, ...validation.fieldIssues].join('; ');
      return buildResult({
        classification: 'AMBIGUOUS',
        parsedTransactions: [],
        draft: emptyDraft(sourceText),
        clarificationRequired: true,
        missingFields: ['property'],
        clarificationQuestion: generateClarificationQuestion({ missingFields: ['property'] }),
        mirrorClarificationPrompt: null,
        reasoning: `CLARIFY_PROPERTY validation failed: ${reason}`,
      });
    }

    const normalized = normalizeTransactionFields(validation.raw, {
      knownProperties,
      sourceText,
      referenceDate: options.referenceDate || new Date(),
    });

    finalizePropertyResolution(normalized, knownProperties);

    const missingFields = [...(normalized.missingFields || [])];
    const propertyAlreadyResolved = Boolean(normalized.draft.property) || Boolean(normalized.pendingNewPropertyName);
    let uniqueMissing = [...new Set(missingFields)].filter((field) => propertyAlreadyResolved && field === 'property' ? false : true);
    
    if (!propertyAlreadyResolved && !uniqueMissing.includes('property')) {
      uniqueMissing.push('property');
    }

    uniqueMissing = sortMissingFieldsByPriority(uniqueMissing);

    const clarificationRequired = uniqueMissing.length > 0;
    const clarificationQuestion = clarificationRequired
      ? generateClarificationQuestion({
          missingFields: uniqueMissing,
          propertyCandidates: normalized.propertyCandidates,
          pendingNewPropertyName: normalized.pendingNewPropertyName,
          draft: normalized.draft,
        })
      : null;

    const singleNormalizedTx = {
      type: normalized.draft.type,
      property: normalized.draft.property,
      amount: normalized.draft.amount,
      category: normalized.draft.category,
      description: normalized.draft.description,
      transactionDate: normalized.draft.transactionDate,
      sourceText: normalized.draft.sourceText,
      pendingNewPropertyName: normalized.draft.pendingNewPropertyName || null,
    };

    return buildResult({
      classification: 'SINGLE',
      parsedTransactions: [singleNormalizedTx],
      draft: singleNormalizedTx,
      clarificationRequired,
      missingFields: uniqueMissing,
      clarificationQuestion,
      mirrorClarificationPrompt: null,
      reasoning: normalized.reasoning || 'CLARIFY_PROPERTY shape parsed.',
    });
  }

  const validation = validateParsingOutput(raw);
  if (!validation.ok) {
    const reason = [...validation.structuralErrors, ...validation.fieldIssues].join('; ');
    return buildResult({
      classification: 'AMBIGUOUS',
      parsedTransactions: [],
      draft: emptyDraft(sourceText),
      clarificationRequired: true,
      missingFields: ['type', 'property', 'amount', 'transactionDate'],
      clarificationQuestion: generateClarificationQuestion({ missingFields: ['type'] }),
      mirrorClarificationPrompt: typeof raw?.clarificationPrompt === 'string' ? raw.clarificationPrompt : null,
      reasoning: `Validation failed: ${reason}`,
    });
  }

  const validRaw = validation.raw;
  const classification = ['SINGLE', 'MULTIPLE', 'AMBIGUOUS', 'INCOMPLETE'].includes(validRaw.classification)
    ? validRaw.classification
    : 'AMBIGUOUS';
  const parsedTransactions = Array.isArray(validRaw.transactions) ? validRaw.transactions : [];
  const mirrorClarificationPrompt =
    typeof validRaw.clarificationPrompt === 'string' && validRaw.clarificationPrompt.trim().length > 0
      ? validRaw.clarificationPrompt.trim()
      : null;

  if (parsedTransactions.length === 0) {
    // The AI returned no transaction skeleton at all — e.g. a bare "Paid",
    // "Rent", or "For repair". We still don't want to default to a
    // one-size-fits-all "which property?" prompt (previously hardcoded here
    // for INCOMPLETE regardless of what the message actually said). Use the
    // same local verb heuristic the fallback draft relies on elsewhere so a
    // message like "Paid" — which already tells us the type — skips
    // straight to the next most useful question ("How much was paid?")
    // instead of asking about something the user hasn't given us any
    // signal about yet.
    const inferredType = inferTypeFromText(sourceText);
    const fallbackDraft = { ...emptyDraft(sourceText), type: inferredType || null };
    const fallbackMissing = sortMissingFieldsByPriority(
      inferredType ? ['amount', 'property'] : ['type', 'amount', 'property'],
    );
    return buildResult({
      classification,
      parsedTransactions: [],
      draft: fallbackDraft,
      clarificationRequired: true,
      missingFields: fallbackMissing,
      // GAP FOUND IN LIVE TESTING: this used to be `mirrorClarificationPrompt
      // || generateClarificationQuestion(...)`. In production the AI's own
      // clarificationPrompt is present far more often than not, so that
      // "prefer the AI's text" ordering meant our single-targeted-field
      // logic almost never actually ran — real output for "Paid" was e.g.
      // "I noted a payment, boss, but could you please specify the amount
      // and which property it is for?" (two fields at once, off-brand
      // "boss" phrasing) instead of the intended "How much was paid?". We
      // still capture mirrorClarificationPrompt below for diagnostics, but
      // the user-facing question is now always our own deterministic one.
      clarificationQuestion: generateClarificationQuestion({ missingFields: fallbackMissing, draft: fallbackDraft }),
      mirrorClarificationPrompt,
      reasoning: typeof validRaw.reasoning === 'string' ? validRaw.reasoning : `No transactions returned; classification=${classification}.`,
    });
  }

  let allUniqueMissing = [];
  let primaryPropertyCandidates = null;
  let primaryPendingNewPropertyName = null;
  let primaryReasoning = '';

  const normalizedTransactions = parsedTransactions.map((tx) => {
    const syntheticLegacy = {
      type: tx.type === 'income' || tx.type === 'expense' ? tx.type : null,
      property: tx.property === null || tx.property === undefined ? null : String(tx.property),
      amount: tx.amount === undefined || tx.amount === null ? null : (typeof tx.amount === 'number' ? tx.amount : null),
      category: tx.category === null || tx.category === undefined ? null : String(tx.category),
      description: tx.description === null || tx.description === undefined ? '' : String(tx.description),
      transactionDate: tx.transactionDate === null || tx.transactionDate === undefined ? null : String(tx.transactionDate),
      clarificationRequired: classification === 'INCOMPLETE' || classification === 'AMBIGUOUS',
      missingFields: Array.isArray(validRaw.missingFields) && validRaw.missingFields.length > 0
        ? validRaw.missingFields
        : classification === 'INCOMPLETE' || classification === 'AMBIGUOUS'
          ? extractMissingFieldsFromTx(tx)
          : [],
      reasoning: typeof validRaw.reasoning === 'string' ? validRaw.reasoning : '',
    };

    const normalized = normalizeTransactionFields(syntheticLegacy, {
      knownProperties,
      sourceText,
      referenceDate: options.referenceDate || new Date(),
    });

    finalizePropertyResolution(normalized, knownProperties);

    const itemMissingFields = [...(normalized.missingFields || [])];
    
    if (!normalized.draft.property && !normalized.draft.pendingNewPropertyName && !itemMissingFields.includes('property')) {
      itemMissingFields.push('property');
    }

    if (itemMissingFields.includes('property')) {
      if (!primaryPropertyCandidates && normalized.propertyCandidates?.length > 1) {
        primaryPropertyCandidates = normalized.propertyCandidates;
      }
      if (!primaryPendingNewPropertyName && normalized.pendingNewPropertyName) {
        primaryPendingNewPropertyName = normalized.pendingNewPropertyName;
      }
    }

    allUniqueMissing.push(...itemMissingFields);

    return {
      type: normalized.draft.type,
      property: normalized.draft.property,
      amount: normalized.draft.amount,
      category: normalized.draft.category,
      description: normalized.draft.description,
      transactionDate: normalized.draft.transactionDate,
      sourceText: normalized.draft.sourceText,
      pendingNewPropertyName: normalized.draft.pendingNewPropertyName || null,
    };
  });

  const uniqueMissing = sortMissingFieldsByPriority([...new Set(allUniqueMissing)]);
  const leadNormalizedTx = normalizedTransactions[0] || emptyDraft(sourceText);

  const isAmbiguousOrIncomplete = classification === 'AMBIGUOUS' || classification === 'INCOMPLETE';

  // GAP FOUND IN LIVE TESTING (real transcript, not simulated): the old
  // `useMirrorOnly` logic trusted the AI's own free-text clarificationPrompt
  // verbatim whenever one was present. That text is written considering the
  // *whole* message, so for a real batch like "Paid for repairs and
  // received 100k rent for orchid" it produced: "I've drafted the ₦100,000
  // rent for Orchid, but how much was spent on the repairs?" — which
  // falsely claims the SECOND item is already drafted (it isn't; only
  // previewed) while asking about the FIRST item's missing amount, all in
  // one confusing sentence. Even for a single incomplete transaction it
  // tends to ask about more than one field at once ("...the amount and
  // which property"), defeating the whole point of this section: one
  // targeted question at a time. So: whenever we can name a concrete
  // missing field ourselves, our own deterministic single-field question
  // always wins. The AI's mirror text is only used as a last resort, for
  // the narrow case where every field we can structurally check for is
  // already present yet the AI still flagged the message ambiguous (e.g. a
  // genuine name collision between two similarly-named properties) — and
  // even then, only for a single-transaction message, never for a batch,
  // to avoid exactly the cross-item-contamination bug above.
  let clarificationRequired = isAmbiguousOrIncomplete || uniqueMissing.length > 0;

  let clarificationQuestion = null;
  if (clarificationRequired) {
    if (uniqueMissing.length > 0) {
      clarificationQuestion = generateClarificationQuestion({
        missingFields: uniqueMissing,
        propertyCandidates: primaryPropertyCandidates,
        pendingNewPropertyName: primaryPendingNewPropertyName,
        draft: leadNormalizedTx,
      });
    } else if (normalizedTransactions.length === 1 && mirrorClarificationPrompt) {
      clarificationQuestion = mirrorClarificationPrompt;
    } else {
      clarificationQuestion = 'Can you confirm a few more details about this transaction before I log it?';
    }
  }

  // Phase 6.3 — confidence floor at the parsing layer, not just the
  // classification layer. Everything above only checks STRUCTURAL
  // completeness (are type/amount/property present); it says nothing
  // about whether the model itself was actually sure of the values it
  // extracted. A structurally complete SINGLE/MULTIPLE result with a
  // confidence the model itself reported as low is exactly the "shaky
  // extraction" this app's "never guess" philosophy exists to catch — so
  // it's downgraded into a clarification instead of sailing straight to
  // PENDING_CONFIRMATION. Only applies when nothing already triggered a
  // clarification above (a genuinely missing field always asks about that
  // specific field first) and only when the model actually reported a
  // confidence number (see isBelowConfidenceFloor — absent confidence is
  // never treated as automatically failing the floor).
  const confidence = normalizeParsingConfidence(validRaw.confidence);
  const belowConfidenceFloor = !clarificationRequired && isBelowConfidenceFloor(validRaw, env.parsingMinConfidence);
  // Bug fix (manual WhatsApp testing): the AI's self-reported confidence
  // alone wasn't reliable enough — a visibly hedged, vague message
  // ("maybe 20 something") still came back with a high enough confidence
  // to sail through. This deterministic backstop checks the raw user text
  // itself for hedging language and forces the same clarification
  // treatment regardless of what the model reported — see
  // hasHedgeLanguage in ParsingValidator.js.
  const hedgeLanguageDetected = !clarificationRequired && !belowConfidenceFloor && hasHedgeLanguage(text);

  if (belowConfidenceFloor || hedgeLanguageDetected) {
    clarificationRequired = true;
    clarificationQuestion = hedgeLanguageDetected
      ? "That sounded a bit uncertain — can you confirm the exact amount, property, and whether this is income or expense before I draft it?"
      : 'I want to make sure I caught that correctly \u2014 can you confirm the amount, property, and whether this is income or expense before I draft it?';
  }

  return buildResult({
    classification,
    parsedTransactions: normalizedTransactions,
    draft: {
      type: leadNormalizedTx.type,
      property: leadNormalizedTx.property,
      amount: leadNormalizedTx.amount,
      category: leadNormalizedTx.category,
      description: leadNormalizedTx.description,
      transactionDate: leadNormalizedTx.transactionDate,
      sourceText: leadNormalizedTx.sourceText,
      pendingNewPropertyName: leadNormalizedTx.pendingNewPropertyName || null,
    },
    clarificationRequired,
    missingFields: uniqueMissing,
    clarificationQuestion,
    mirrorClarificationPrompt,
    reasoning: (() => {
      if (belowConfidenceFloor) return `Low parsing confidence (${confidence} < ${env.parsingMinConfidence}); ${primaryReasoning || `classification=${classification}`}`;
      if (hedgeLanguageDetected) return `Hedge language detected in raw message; ${primaryReasoning || `classification=${classification}`}`;
      return primaryReasoning || `classification=${classification}`;
    })(),
    confidence,
  });
}

// Used by DraftManager.js when advancing to the next queued transaction in
// a multi-transaction batch (see the W follow-through fix): those items are
// already fully normalized (property resolved to an ID or
// pendingNewPropertyName, amount coerced to a number, etc.) — this checks
// completeness on that normalized shape, unlike extractMissingFieldsFromTx
// above which checks the raw AI-extraction shape.
export function missingFieldsForNormalizedTransaction(tx = {}) {
  const missing = [];
  if (!tx.type || (tx.type !== 'income' && tx.type !== 'expense')) missing.push('type');
  if (!tx.amount || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) missing.push('amount');
  if (!tx.property && !tx.pendingNewPropertyName) missing.push('property');
  if (tx.type === 'expense' && !tx.category) missing.push('category');
  if (!tx.transactionDate) missing.push('transactionDate');
  return sortMissingFieldsByPriority(missing);
}

function extractMissingFieldsFromTx(tx = {}) {
  // Ordered to match MISSING_FIELD_PRIORITY in TransactionNormalizer.js:
  // type, then amount, then property — see that file for why amount is
  // asked before property.
  const missing = [];
  if (!tx.type || (tx.type !== 'income' && tx.type !== 'expense')) missing.push('type');
  if (!tx.amount || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) missing.push('amount');
  if (!tx.property) missing.push('property');
  if (tx.type === 'expense' && !tx.category) missing.push('category');
  if (!tx.transactionDate) missing.push('transactionDate');
  return missing;
}

function buildResult({
  classification,
  parsedTransactions,
  draft,
  clarificationRequired,
  missingFields,
  clarificationQuestion,
  mirrorClarificationPrompt,
  reasoning,
  aiUnavailable = false,
  confidence = null,
}) {
  return {
    classification: classification || 'AMBIGUOUS',
    parsedTransactions: Array.isArray(parsedTransactions) ? parsedTransactions : [],
    draft,
    clarificationRequired: Boolean(clarificationRequired),
    missingFields: Array.isArray(missingFields) ? missingFields : [],
    clarificationQuestion: clarificationQuestion || null,
    mirrorClarificationPrompt: mirrorClarificationPrompt || null,
    reasoning: reasoning || '',
    aiUnavailable: Boolean(aiUnavailable),
    // Phase 6.3 — surfaced for diagnostics/tests; null when the model
    // didn't report a confidence value at all.
    confidence: typeof confidence === 'number' ? confidence : null,
  };
}

export default { parseTransaction, missingFieldsForNormalizedTransaction };