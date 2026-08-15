/**
 * ParsingValidator
 * Validates the raw JSON structures coming out of the AI extraction layer.
 * Ensures strict typing before data hits normalizers or orchestrators.
 */

// Phase 6.3 — confidence floor at the parsing layer, mirroring the pattern
// already established in MessageClassifier.js (classification layer) and
// QueryInterpreter.js (query-interpretation layer). Neither
// AiParsingService.js nor TransactionParser.js previously checked
// confidence at all, so a structurally "complete" but shaky extraction
// (all fields technically filled in, but the model wasn't actually sure)
// was accepted and drafted exactly like a confident one.
//
// Returns null (no signal) rather than throwing/forcing a failure when
// confidence is absent — a provider that doesn't yet return this field, or
// a test double built before this field existed, must not be treated as
// "automatically below the floor". The floor only ever fires when the
// model actually reported a low-confidence number itself.
export function normalizeParsingConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0 || value > 1) {
    return null;
  }
  return value;
}

export function isBelowConfidenceFloor(raw, minConfidence = 0.6) {
  const confidence = normalizeParsingConfidence(raw?.confidence);
  if (confidence === null) {
    return false;
  }
  return confidence < minConfidence;
}

// Bug fix (manual WhatsApp testing): "E mm paid sm for stuff at the place
// maybe 20 something" — visibly hedged, vague on every field — was
// confidently drafted as a real ₦20 expense. The 6.3 confidence floor
// above relies entirely on the AI's OWN self-reported confidence number,
// and that number apparently wasn't low enough to trip the floor despite
// the message being obviously uncertain to a human reader. This is a
// deterministic backstop that doesn't depend on the model rating itself
// accurately: if the RAW MESSAGE ITSELF contains the speaker's own
// hedging language, that alone is enough to force a clarification,
// regardless of what confidence value came back.
//
// Deliberately narrow to words that signal the SPEAKER doesn't know the
// answer themselves ("maybe," "not sure," "something") — not ordinary,
// deliberate approximation ("about 20k," "around 5k"), which is common,
// perfectly usable phrasing in everyday Nigerian English and would be
// annoying to block on every use.
const HEDGE_LANGUAGE_PATTERN =
  /\b(maybe|perhaps|not sure|dunno|don'?t know|i think|i guess|something|somethin|kind of|sort of)\b/i;

export function hasHedgeLanguage(text) {
  return HEDGE_LANGUAGE_PATTERN.test(String(text || ''));
}

export function validateParsingOutput(raw) {
  const structuralErrors = [];
  const fieldIssues = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      raw: null,
      structuralErrors: ['AI output must be a valid JSON object'],
      fieldIssues: [],
    };
  }

  const classification = typeof raw.classification === 'string' ? raw.classification.trim() : '';
  const isValidClassification = ['SINGLE', 'MULTIPLE', 'AMBIGUOUS', 'INCOMPLETE'].includes(classification);
  const intent = typeof raw.intent === 'string' ? raw.intent.trim() : '';

  if (isValidClassification) {
    if (!Array.isArray(raw.transactions)) {
      structuralErrors.push('"transactions" must be an array when classification is set');
    } else {
      raw.transactions.forEach((tx, i) => {
        if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
          structuralErrors.push(`transactions[${i}] must be an object`);
          return;
        }

        const typeRaw = typeof tx.type === 'string' ? tx.type.trim().toLowerCase() : '';
        if (typeRaw && typeRaw !== 'income' && typeRaw !== 'expense') {
          fieldIssues.push(`transactions[${i}].type must be income, expense, or empty`);
        }

        if (tx.amount !== null && tx.amount !== undefined) {
          const parsedAmount = Number(tx.amount);
          if (typeof tx.amount === 'boolean' || typeof tx.amount === 'object' || Number.isNaN(parsedAmount) || !Number.isFinite(parsedAmount)) {
            fieldIssues.push(`transactions[${i}].amount must be a valid number, numeric string, or null`);
          }
        }

        const stringOrNullFields = ['property', 'category', 'description', 'transactionDate'];
        stringOrNullFields.forEach((field) => {
          if (tx[field] !== null && tx[field] !== undefined && typeof tx[field] !== 'string') {
            fieldIssues.push(`transactions[${i}].${field} must be a string or null`);
          }
        });
      });
    }

    if (raw.clarificationPrompt !== null && raw.clarificationPrompt !== undefined && typeof raw.clarificationPrompt !== 'string') {
      fieldIssues.push('"clarificationPrompt" must be a string or null');
    }

    return {
      ok: structuralErrors.length === 0 && fieldIssues.length === 0,
      raw,
      structuralErrors,
      fieldIssues,
    };
  }

  if (intent === 'CLARIFY_PROPERTY') {
    const requiredClarifyKeys = ['type', 'property', 'amount', 'missingFields'];
    requiredClarifyKeys.forEach((key) => {
      if (!(key in raw)) structuralErrors.push(`Missing key: ${key} for CLARIFY_PROPERTY intent`);
    });

    if (structuralErrors.length > 0) {
      return { ok: false, raw, structuralErrors, fieldIssues };
    }

    if (typeof raw.property !== 'string') fieldIssues.push('property must be a string');
    if (raw.type && typeof raw.type === 'string' && !['income', 'expense'].includes(raw.type.trim().toLowerCase())) {
      fieldIssues.push('type must be income, expense, or empty');
    }
    if (raw.amount !== null && raw.amount !== undefined) {
      const parsedAmount = Number(raw.amount);
      if (typeof raw.amount === 'boolean' || typeof raw.amount === 'object' || Number.isNaN(parsedAmount) || !Number.isFinite(parsedAmount)) {
        fieldIssues.push('amount must be a valid number, numeric string, or null');
      }
    }
    if (!Array.isArray(raw.missingFields)) {
      fieldIssues.push('missingFields must be an array');
    }

    return {
      ok: structuralErrors.length === 0 && fieldIssues.length === 0,
      raw,
      structuralErrors,
      fieldIssues,
    };
  }

  const requiredLegacyKeys = [
    'type',
    'property',
    'amount',
    'category',
    'description',
    'transactionDate',
    'clarificationRequired',
    'missingFields',
  ];

  requiredLegacyKeys.forEach((key) => {
    if (!(key in raw)) structuralErrors.push(`Missing legacy key: ${key}`);
  });

  if (structuralErrors.length > 0) {
    return { ok: false, raw, structuralErrors, fieldIssues };
  }

  if (typeof raw.type !== 'string') {
    fieldIssues.push('type must be a string');
  } else {
    const type = raw.type.trim().toLowerCase();
    if (type && type !== 'income' && type !== 'expense') fieldIssues.push('type must be income or expense');
  }

  if (typeof raw.property !== 'string') fieldIssues.push('property must be a string');

  if (raw.amount !== null && raw.amount !== undefined) {
    const parsedAmount = Number(raw.amount);
    if (typeof raw.amount === 'boolean' || typeof raw.amount === 'object' || Number.isNaN(parsedAmount) || !Number.isFinite(parsedAmount)) {
      fieldIssues.push('amount must be a valid number, numeric string, or null');
    }
  }

  if (typeof raw.category !== 'string' && raw.category !== null) fieldIssues.push('category must be a string or null');
  if (typeof raw.description !== 'string') fieldIssues.push('description must be a string');
  if (typeof raw.transactionDate !== 'string') fieldIssues.push('transactionDate must be a string');
  if (typeof raw.clarificationRequired !== 'boolean') fieldIssues.push('clarificationRequired must be a boolean');

  if (!Array.isArray(raw.missingFields)) {
    fieldIssues.push('missingFields must be an array');
  } else if (!raw.missingFields.every((item) => typeof item === 'string')) {
    fieldIssues.push('missingFields must contain only strings');
  }

  if (typeof raw.reasoning !== 'undefined' && typeof raw.reasoning !== 'string') {
    fieldIssues.push('reasoning must be a string');
  }

  return {
    ok: structuralErrors.length === 0 && fieldIssues.length === 0,
    raw,
    structuralErrors,
    fieldIssues,
  };
}

export default { validateParsingOutput, normalizeParsingConfidence, isBelowConfidenceFloor, hasHedgeLanguage };