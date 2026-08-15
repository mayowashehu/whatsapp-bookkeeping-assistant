import { resolveProperty, normalizeTransactionDate } from '../../ai/parsing/TransactionNormalizer.js';
import { generateClarificationQuestion, formatTransitionFeedback } from '../../ai/parsing/ClarificationService.js';
import { formatNaira } from '../../utils/currencyFormatter.js';

export function applyClarificationAnswer(pendingDraft, answer, options = {}) {
  if (!pendingDraft?.clarification?.awaiting) {
    return {
      completed: false,
      error: 'Draft is not awaiting clarification.',
    };
  }

  const knownProperties = Array.isArray(options.knownProperties) ? options.knownProperties : [];
  const draftEntry = typeof pendingDraft.draftEntry?.toObject === 'function'
    ? pendingDraft.draftEntry.toObject()
    : { ...pendingDraft.draftEntry };

  const missingFields = [...(pendingDraft.clarification.missingFields || [])].filter((field) =>
    isFieldStillMissing(field, draftEntry),
  );

  if (missingFields.length === 0) {
    return {
      completed: true,
      draftEntry,
      clarification: {
        awaiting: false,
        missingFields: [],
        question: '',
      },
    };
  }

  const currentField = missingFields.shift();
  const handler = FIELD_HANDLERS[currentField];

  if (!handler) {
    return {
      completed: false,
      error: `Unsupported clarification field "${currentField}".`,
    };
  }

  const parsed = handler(answer, { knownProperties, draftEntry, referenceDate: options.referenceDate || new Date() });

  if (!parsed.ok) {
    return {
      completed: false,
      error: parsed.error,
    };
  }

  draftEntry[currentField] = parsed.value;
  if (currentField === 'property' && parsed.pendingNewPropertyName !== undefined) {
    draftEntry.pendingNewPropertyName = parsed.pendingNewPropertyName;
  } else if (currentField === 'property' && parsed.value) {
    draftEntry.pendingNewPropertyName = null;
  }

  if (missingFields.length === 0) {
    return {
      completed: true,
      draftEntry,
      clarification: {
        awaiting: false,
        missingFields: [],
        question: '',
      },
    };
  }

  const nextField = missingFields[0];

  // FIX (F/G): resolvedValueText previously leaked the raw stored value for
  // 'property' (a database ObjectId when matched) straight into the user-facing
  // transition message. Each field now has an explicit, human-readable display
  // rule instead of relying on the raw parsed/stored value.
  const resolvedValueText = formatResolvedValueForDisplay(currentField, parsed);

  const transitionalQuestion = formatTransitionFeedback({
    resolvedField: currentField,
    resolvedValue: resolvedValueText,
    nextField,
  });

  return {
    completed: false,
    draftEntry,
    clarification: {
      awaiting: true,
      missingFields,
      question: transitionalQuestion,
    },
  };
}

function formatResolvedValueForDisplay(field, parsed) {
  if (field === 'property') {
    // parsed.displayValue always holds the human-readable name — the matched
    // property's name, or the freeform text if it's a new/pending property —
    // never the raw ObjectId that parsed.value holds when matched.
    return parsed.displayValue;
  }
  if (field === 'amount') {
    return formatNaira(parsed.value);
  }
  if (field === 'type') {
    return parsed.value === 'income' ? 'Income' : 'Expense';
  }
  return parsed.value;
}

// Natural replies to "which property should I assign this to?" often wrap
// the actual property name in a short phrase — "assign it to Orchid",
// "it's for Flat 2", "use Green Villa". Matching resolveProperty against
// the WHOLE reply requires an exact canonicalized match, so any wrapper
// text makes it fail — and previously that failure fell straight through to
// "treat the entire reply as a brand new property name", silently creating
// a property literally named "Assign it to Orchid" instead of resolving to
// the known property "Orchid". This strips the wrapper first.
const PROPERTY_ANSWER_WRAPPERS = [
  /^(?:assign|attribute|charge|book|log|put|record)\s+(?:it|this|that)?\s*(?:to|under|for|on|at)\s+(.+)$/i,
  /^(?:it'?s|that'?s|this\s+is)\s+(?:for|at|to)\s+(.+)$/i,
  /^use\s+(.+)$/i,
  /^for\s+(.+)$/i,
];

function extractConversationalPropertyMention(rawAnswer) {
  const trimmed = String(rawAnswer || '').trim();
  for (const pattern of PROPERTY_ANSWER_WRAPPERS) {
    const match = pattern.exec(trimmed);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim().replace(/[.!?]+$/, '');
    }
  }
  return trimmed;
}

// Phase 6.2 — "never guess" applied to a clarification answer that is
// ITSELF a relative reference instead of a concrete name ("same as
// yesterday", "same as last time", "the usual place", "like before",
// "again"). This layer is deterministic and has no access to
// RECENT TRANSACTIONS/RECENT CONVERSATION context (that resolution
// happens earlier, at the AI parsing layer — see
// parseTransaction.js's RELATIVE-REFERENCE RESOLUTION rules), so it
// cannot safely resolve what the reference actually points to. Without
// this guard, resolveProperty would fail to match any known property and
// fall through to silently creating a brand-new property literally named
// "same as yesterday" — exactly the kind of guess this app's philosophy
// forbids. Matching this pattern re-asks for the concrete name instead.
const PURE_RELATIVE_REFERENCE_PATTERN = new RegExp(
  '^(?:'
    + '(?:the\\s+)?same(?:\\s+(?:one|place|property|thing|apartment|flat))?(?:\\s+as\\s+(?:yesterday|before|last\\s+time))?'
    + '|the\\s+usual(?:\\s+place)?'
    + '|as\\s+(?:before|last\\s+time)'
    + '|like\\s+(?:before|last\\s+time)'
    + '|again'
    + '|previous(?:ly)?(?:\\s+one)?'
    + '|that\\s+one'
    + '|the\\s+last\\s+one'
    + ')$',
  'i',
);

function isPureRelativeReference(mention) {
  const clean = String(mention || '').trim().replace(/[.!?]+$/, '');
  if (!clean) return false;
  return PURE_RELATIVE_REFERENCE_PATTERN.test(clean);
}

const FIELD_HANDLERS = {
  amount(answer) {
    let cleanInput = String(answer).toLowerCase().replace(/,/g, '').trim();
    if (cleanInput.includes('k')) {
      const match = cleanInput.match(/^([\d.]+)\s*k/);
      if (match) cleanInput = String(Number(match[1]) * 1000);
    } else {
      cleanInput = cleanInput.replace(/[a-z\s]+/g, '');
    }
    const value = Number(cleanInput);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: 'Please enter a valid amount (numbers only, e.g., 25000 or 25k).' };
    }
    return { ok: true, value };
  },

  type(answer) {
    const value = String(answer).trim().toLowerCase();
    if (value.includes('expense') || value.includes('outflow') || value.includes('spent') || value.includes('paid')) {
      return { ok: true, value: 'expense' };
    }
    if (value.includes('income') || value.includes('inflow') || value.includes('received') || value.includes('made')) {
      return { ok: true, value: 'income' };
    }
    return { ok: false, error: 'Please clarify if this is an Income or an Expense.' };
  },

  property(answer, { knownProperties, draftEntry }) {
    const trimmedAnswer = String(answer || '').trim();
    if (draftEntry?.pendingNewPropertyName && (trimmedAnswer.toLowerCase() === 'yes' || trimmedAnswer.toLowerCase() === 'y')) {
      return {
        ok: true,
        value: null,
        pendingNewPropertyName: draftEntry.pendingNewPropertyName,
        displayValue: draftEntry.pendingNewPropertyName,
      };
    }

    const mention = extractConversationalPropertyMention(trimmedAnswer);

    if (isPureRelativeReference(mention)) {
      return {
        ok: false,
        error: "I can't tell which property that refers to \u2014 please name it directly, e.g. Orchid Apartment or Flat 2.",
      };
    }

    const resolved = resolveProperty(mention, knownProperties);

    if (resolved.status === 'matched') {
      return {
        ok: true,
        value: resolved.property.id,
        pendingNewPropertyName: null,
        displayValue: resolved.property.name,
      };
    }

    if (resolved.status === 'ambiguous') {
      const names = resolved.candidates.map((c) => c.name).join(' or ');
      return { ok: false, error: `Which property did you mean: ${names}?` };
    }

    return {
      ok: true,
      value: null,
      pendingNewPropertyName: mention,
      displayValue: mention,
    };
  },

  transactionDate(answer, { referenceDate = new Date() }) {
    const iso = normalizeTransactionDate(answer, referenceDate);
    if (!iso) {
      return {
        ok: false,
        error: 'Please enter a valid date (e.g., Today, Yesterday, or 12 Jan).',
      };
    }
    return { ok: true, value: new Date(`${iso}T12:00:00+01:00`) };
  },

  category(answer) {
    const value = String(answer).trim().toLowerCase();
    if (!value) return { ok: false, error: 'Category cannot be empty.' };
    return { ok: true, value };
  },

  description(answer) {
    return { ok: true, value: String(answer).trim() };
  },
};

function isFieldStillMissing(field, draftEntry) {
  if (field === 'property') {
    return !draftEntry.property && !draftEntry.pendingNewPropertyName;
  }
  if (field === 'amount') {
    return !draftEntry.amount || draftEntry.amount <= 0;
  }
  if (field === 'type') {
    return !draftEntry.type;
  }
  if (field === 'category') {
    return draftEntry.type === 'expense' && !draftEntry.category;
  }
  if (field === 'transactionDate') {
    return !draftEntry.transactionDate;
  }
  return true;
}

export default { applyClarificationAnswer };