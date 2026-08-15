import { normalizeTransactionDate } from '../../ai/parsing/TransactionNormalizer.js';

/**
 * Maps a parser draft into a PendingDraft.draftEntry document shape.
 * Build-up approach: Only include keys that contain actual valid data.
 */
export function mapParserDraftToDraftEntry(parserDraft = {}) {
  if (!parserDraft || typeof parserDraft !== 'object') {
    return {};
  }

  const mapped = {};

  // 1. Validate and map Type
  if (parserDraft.type) {
    const t = String(parserDraft.type).toLowerCase().trim();
    if (t === 'income' || t === 'expense') {
      mapped.type = t;
    }
  }

  // 2. Validate and map Amount
  if (parserDraft.amount !== undefined && parserDraft.amount !== null && parserDraft.amount !== '') {
    const parsedAmount = Number(parserDraft.amount);
    if (!Number.isNaN(parsedAmount)) {
      mapped.amount = parsedAmount;
    }
  }

  // 3. Validate and map Property
if (parserDraft.property) {
  mapped.property = parserDraft.property;
}
  // 4. Validate and map Category (Only allowed if expense)
  if (mapped.type === 'expense' && parserDraft.category) {
    const cat = String(parserDraft.category).trim();
    if (cat !== '') {
      mapped.category = cat;
    }
  }

  // 5. Validate and map Description
  if (parserDraft.description) {
    const desc = String(parserDraft.description).trim();
    if (desc !== '') {
      mapped.description = desc;
    }
  } else {
    mapped.description = '';
  }

  // 6. Validate and map Source Text
  if (parserDraft.sourceText) {
    mapped.sourceText = String(parserDraft.sourceText).trim();
  }

  // 7. Validate and map Transaction Date
  if (parserDraft.transactionDate) {
    mapped.transactionDate = toLagosNoonDate(parserDraft.transactionDate);
  }

  // 8. Validate and map Pending New Property Name
  if (parserDraft.pendingNewPropertyName) {
    const propName = String(parserDraft.pendingNewPropertyName).trim();
    if (propName !== '') {
      mapped.pendingNewPropertyName = propName;
    }
  }

  return mapped;
}

function toLagosNoonDate(isoDate, referenceDate = new Date()) {
  if (isoDate instanceof Date && !Number.isNaN(isoDate.getTime())) {
    return new Date(isoDate);
  }

  const textDate = String(isoDate ?? '').trim();
  if (!textDate) {
    return new Date();
  }

  const normalizedDate = normalizeTransactionDate(textDate, referenceDate);
  if (normalizedDate) {
    const parsedDate = new Date(`${normalizedDate}T12:00:00+01:00`);
    return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
  }

  const dateOnly = textDate.split('T')[0];
  const parsedDate = new Date(`${dateOnly}T12:00:00+01:00`);

  return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
}

export default {
  mapParserDraftToDraftEntry,
};