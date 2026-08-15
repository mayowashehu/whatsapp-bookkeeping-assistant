// src/services/draft/CorrectionProcessor.js
import {
  normalizeAmount,
  normalizeTransactionDate,
  resolveProperty,
} from '../../ai/parsing/TransactionNormalizer.js';
import { generateClarificationQuestion } from '../../ai/parsing/ClarificationService.js';
import { formatNaira } from '../../utils/currencyFormatter.js';
import { formatDisplayDate } from './DraftFormatter.js';

// FIX (H): human-readable labels for building a change summary instead of
// guessing meaning from a raw field-name string downstream.
const FIELD_LABELS = {
  type: 'the type',
  property: 'the property',
  amount: 'the amount',
  category: 'the category',
  transactionDate: 'the date',
  description: 'the description',
};

/**
 * Applies a structured correction patch onto an existing pending draft entry.
 * Safely handles field normalizations, dates, and Mongoose populated property records.
 *
 * @param {object} currentEntry DB-shaped draftEntry (property may be ObjectId or populated object)
 * @param {object} patch Structured patch payload containing corrected data fields
 * @param {{ knownProperties: Array, referenceDate?: Date }} options
 */
function isMeaningfulPatchValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && !value.trim()) return false;
  return true;
}

export function applyCorrectionPatch(currentEntry, patch, options = {}) {
  const knownProperties = Array.isArray(options.knownProperties) ? options.knownProperties : [];
  const referenceDate = options.referenceDate || new Date();
  const safePatch = patch && typeof patch === 'object' ? patch : {};

  // Clone current baseline state safely resolving objects to IDs
  const next = {
    type: currentEntry.type,
    property: extractPropertyId(currentEntry.property),
    pendingNewPropertyName: currentEntry.pendingNewPropertyName || null,
    amount: currentEntry.amount,
    category: currentEntry.category ?? null,
    description: currentEntry.description || '',
    sourceText: currentEntry.sourceText,
    transactionDate: currentEntry.transactionDate,
  };

  const missingFields = [];
  const changedFields = []; // FIX (H): tracks what actually changed, with display text, per field
  let propertyCandidates = [];

  // 1. Process Type Overrides
  if (Object.prototype.hasOwnProperty.call(safePatch, 'type') && isMeaningfulPatchValue(safePatch.type)) {
    const type = String(safePatch.type || '').trim().toLowerCase();
    if (type !== 'income' && type !== 'expense') {
      missingFields.push('type');
    } else {
      next.type = type;
      changedFields.push({ field: 'type', display: `${FIELD_LABELS.type} to ${type}` });
    }
  }

  // 2. Process Property Overrides
  if (Object.prototype.hasOwnProperty.call(safePatch, 'property') && isMeaningfulPatchValue(safePatch.property)) {
    const mention = safePatch.property && typeof safePatch.property === 'object'
      ? safePatch.property.name || safePatch.property.id
      : safePatch.property;

    const trimmedMention = String(mention || '').trim();
    const resolved = resolveProperty(trimmedMention, knownProperties);
    propertyCandidates = resolved.candidates || [];

    if (resolved.status === 'matched') {
      next.property = resolved.property.id;
      next.pendingNewPropertyName = null;
      changedFields.push({ field: 'property', display: `${FIELD_LABELS.property} to ${resolved.property.name}` });
    } else if (trimmedMention) {
      next.property = null;
      next.pendingNewPropertyName = trimmedMention;
      changedFields.push({ field: 'property', display: `${FIELD_LABELS.property} to ${trimmedMention}` });
    } else {
      missingFields.push('property');
    }
  }

  // 3. Process Amount Overrides
  if (Object.prototype.hasOwnProperty.call(safePatch, 'amount') && isMeaningfulPatchValue(safePatch.amount)) {
    const amount = normalizeAmount(safePatch.amount);
    if (amount === null) {
      missingFields.push('amount');
    } else {
      next.amount = amount;
      changedFields.push({ field: 'amount', display: `${FIELD_LABELS.amount} to ${formatNaira(amount)}` });
    }
  }

  // 4. Process Description Overrides
  if (Object.prototype.hasOwnProperty.call(safePatch, 'description') && isMeaningfulPatchValue(safePatch.description)) {
    next.description = typeof safePatch.description === 'string' ? safePatch.description.trim() : '';
    changedFields.push({ field: 'description', display: `${FIELD_LABELS.description} to "${next.description}"` });
  }

  // 5. Process Transaction Date Overrides
  if (Object.prototype.hasOwnProperty.call(safePatch, 'transactionDate') && isMeaningfulPatchValue(safePatch.transactionDate)) {
    const rawDateValue = String(safePatch.transactionDate).trim();
    const yearOnlyMatch = /^(20\d{2})$/.exec(rawDateValue);

    // "Edit the year to 2026" — normalizeTransactionDate can't parse a bare
    // year (it needs a full date phrase like "today" or "12 Jan"), so
    // without this it would silently fail to apply the correction and just
    // re-ask "what date did this happen?" — discarding the year the user
    // just gave. Instead: keep the existing month/day, swap only the year.
    let resolvedDate = null;
    if (yearOnlyMatch && currentEntry.transactionDate) {
      const existing = new Date(currentEntry.transactionDate);
      if (!Number.isNaN(existing.getTime())) {
        resolvedDate = new Date(existing);
        resolvedDate.setUTCFullYear(Number(yearOnlyMatch[1]));
      }
    }

    if (resolvedDate) {
      next.transactionDate = resolvedDate;
      changedFields.push({ field: 'transactionDate', display: `${FIELD_LABELS.transactionDate} to ${formatDisplayDate(resolvedDate)}` });
    } else {
      const iso = normalizeTransactionDate(rawDateValue, referenceDate);
      if (!iso) {
        missingFields.push('transactionDate');
      } else {
        next.transactionDate = new Date(`${iso}T12:00:00+01:00`);
        changedFields.push({ field: 'transactionDate', display: `${FIELD_LABELS.transactionDate} to ${formatDisplayDate(next.transactionDate)}` });
      }
    }
  }

  // 6. Enforce Category Rules
  if (next.type === 'income') {
    next.category = null;
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'category') && isMeaningfulPatchValue(safePatch.category)) {
    const category = typeof safePatch.category === 'string' ? safePatch.category.trim() : '';
    if (!category) {
      missingFields.push('category');
    } else {
      next.category = category;
      changedFields.push({ field: 'category', display: `${FIELD_LABELS.category} to ${category}` });
    }
  }

  // 7. Post-Patch Structural Validation Check
  if (!next.type) missingFields.push('type');
  if (!next.property && !next.pendingNewPropertyName) missingFields.push('property');
  if (!next.amount || next.amount <= 0) missingFields.push('amount');
  if (!next.transactionDate) missingFields.push('transactionDate');
  if (next.type === 'expense' && !next.category) missingFields.push('category');

  const uniqueMissing = [...new Set(missingFields)];
  const clarificationRequired = uniqueMissing.length > 0;

  // FIX (H): build one clear, complete sentence describing everything that
  // was actually changed, instead of the caller guessing from a raw field key.
  const changeSummary = changedFields.length > 0
    ? joinWithAnd(changedFields.map((c) => c.display))
    : 'the draft';

  return {
    draftEntry: {
      type: next.type,
      property: next.property,
      pendingNewPropertyName: next.pendingNewPropertyName,
      amount: next.amount,
      category: next.type === 'income' ? null : next.category,
      description: next.description,
      sourceText: next.sourceText,
      transactionDate: next.transactionDate,
    },
    clarificationRequired,
    missingFields: uniqueMissing,
    clarificationQuestion: clarificationRequired
      ? generateClarificationQuestion({
          missingFields: uniqueMissing,
          propertyCandidates,
        })
      : null,
    changeSummary,
  };
}

function joinWithAnd(parts) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function extractPropertyId(property) {
  if (!property) return null;
  if (typeof property === 'object' && property._id) return String(property._id);
  if (typeof property === 'object' && property.id) return String(property.id);
  return String(property);
}

export default {
  applyCorrectionPatch,
};