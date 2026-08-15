import env from '../../config/env.js';
import { isAiUnavailableError } from '../../ai/aiFallback.js';
import { createAIService } from '../../ai/createAIService.js';
import { getGeminiQueryModel } from '../../services/ai/geminiClient.js';
import { resolveProperty, MONTHS, getLagosDateString } from '../../ai/parsing/TransactionNormalizer.js';
import { INTERPRET_QUERY_SCHEMA_HINT, buildInterpretQuerySystemPrompt } from '../../prompts/interpretQuery.js';
import { buildContextualSystemPrompt } from '../../prompts/contextPromptBuilder.js';
import { getConversationContext, getRecentTransactions } from '../ContextService.js';
import { QUERY_PERIODS } from './queryPeriod.js';

// Mirrors the hard cap in QueryRepository.findLastTransactions — kept as
// one named constant so the two can't silently drift apart.
export const MAX_TRANSACTIONS_LIMIT = 50;

export const QUERY_TYPES = Object.freeze({
  TOTAL_INCOME: 'TOTAL_INCOME', TOTAL_EXPENSES: 'TOTAL_EXPENSES', NET_INCOME: 'NET_INCOME',
  EXPENSES_BY_CATEGORY: 'EXPENSES_BY_CATEGORY', LAST_TRANSACTIONS: 'LAST_TRANSACTIONS',
  PROPERTY_SUMMARY: 'PROPERTY_SUMMARY', PORTFOLIO_SUMMARY: 'PORTFOLIO_SUMMARY',
  BIGGEST_EXPENSE: 'BIGGEST_EXPENSE', LIST_PROPERTIES: 'LIST_PROPERTIES',
  // Task 3.3 — companion to flagging (3.2): once something is flagged for
  // review there needs to be a way to come back and actually see it again,
  // or flagging is a dead end. Deliberately its own query type rather than
  // a filter bolted onto LAST_TRANSACTIONS — a "what needs my attention"
  // list has a different default scope (all time, not this month) and a
  // different empty-state message than a plain recency list.
  FLAGGED_TRANSACTIONS: 'FLAGGED_TRANSACTIONS',
  UNKNOWN: 'UNKNOWN',
});

// Single source of truth for "this text is about expenses" — used both to
// keep the portfolio-summary guard from firing on expense-flavored text AND
// to actually detect TOTAL_EXPENSES. Previously these were two separate,
// slightly different word lists (the guard only knew "spent", not "spend"/
// "spending"/"paid out"), so "how much did I spend?" slipped past the guard
// and was misclassified as a portfolio summary instead of total expenses.
const EXPENSE_KEYWORDS = /\b(expense|expenses|spent|spend|spending|paid out)\b/;
const INCOME_KEYWORDS = /\b(income|received|generated|rent|earning|earnings)\b/;

export async function interpretQuery(text, options = {}) {
  const knownProperties = Array.isArray(options.knownProperties) ? options.knownProperties : [];
  const referenceDate = options.referenceDate || new Date();
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const senderId = options.senderId;

  if (!trimmed) return unknownRequest('Empty query.');

  const deterministic = interpretDeterministically(trimmed, knownProperties, referenceDate);
  if (deterministic) return { ...deterministic, source: 'deterministic' };

  const aiService = options.aiService || createAIService({
    model: getGeminiQueryModel() || env.geminiQueryModel || env.geminiClassifierModel,
  });

  // Fetch context if senderId is provided
  let chatHistory = [];
  let recentTransactions = [];
  if (senderId) {
    chatHistory = await getConversationContext(senderId);
    recentTransactions = await getRecentTransactions(senderId);
  }

  // Build contextual system prompt
  const contextualSystemPrompt = buildContextualSystemPrompt(
    buildInterpretQuerySystemPrompt(knownProperties.map((p) => p.name)), 
    { chatHistory, recentTransactions }
  );

  try {
    const raw = await aiService.completeJson({
      system: contextualSystemPrompt,
      user: trimmed,
      schemaHint: INTERPRET_QUERY_SCHEMA_HINT,
    });
    return normalizeAiInterpretation(raw, knownProperties, referenceDate, trimmed.toLowerCase());
  } catch (err) {
    if (isAiUnavailableError(err)) {
      return aiUnavailableRequest(err.message);
    }
    return unknownRequest(`AI interpretation failed: ${err.message}`);
  }
}

function interpretDeterministically(text, knownProperties, referenceDate) {
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  
  // Detect property list query first
  if (/\b(list my properties|what are my properties|which properties|my properties|list properties)\b/.test(lower) || /\b(list|what are|which)\s+(my)?\s*(properties|apartments|flats|units)\b/.test(lower)) {
    return buildRequest({ queryType: QUERY_TYPES.LIST_PROPERTIES, period: null, property: null, category: null, limit: null, confidence: 0.98, reasoning: 'Matched property list pattern.' });
  }

  // FIXED: Execute all detections before early return to prevent ReferenceErrors
  const explicitPeriod = detectExplicitPeriod(lower);
  const explicitMonth = detectExplicitMonth(lower, referenceDate);
  const period = explicitPeriod || QUERY_PERIODS.THIS_MONTH;
  const category = detectCategory(lower);
  const limit = detectLimit(lower) || env.queryLastN;
  const propertyDetection = detectProperty(lower, knownProperties);
  const propertyMatch = propertyDetection.status === 'matched' ? propertyDetection.property : null;

  // N: a query with NO explicit period, NO explicit month, NO property, and
  // NO category gives us nothing to scope an answer to — e.g. "how much did
  // I spend?", "what's my summary?", "show me everything". Previously these
  // silently defaulted to "this month" without telling the user, which
  // reads as an approximate/unclear answer rather than a deliberate one.
  // Ask instead.
  const vagueScope = !explicitPeriod && !explicitMonth && !propertyMatch && !category;

  // Detect portfolio summary queries: "how much this month", "summary", "how much I collect", etc.
  const isPortfolioSummary = (/\b(summary|everything)\b/.test(lower) || /\bhow much\b/.test(lower) && !category && !INCOME_KEYWORDS.test(lower) && !EXPENSE_KEYWORDS.test(lower)) && !propertyMatch;
  if (isPortfolioSummary) {
    if (vagueScope) return scopeClarificationRequest({ queryType: QUERY_TYPES.PORTFOLIO_SUMMARY });
    return buildRequest({ queryType: QUERY_TYPES.PORTFOLIO_SUMMARY, period, property: null, category: null, limit: null, confidence: 0.9, reasoning: 'Matched portfolio summary pattern.', month: explicitMonth?.month, year: explicitMonth?.year });
  }

  if (propertyDetection.status === "unmatched") {
    return {
      ...buildRequest({ queryType: QUERY_TYPES.UNKNOWN, period, property: null, category, limit, confidence: 1, reasoning: "Unknown property mentioned." }),
      unmatchedProperty: propertyDetection.unmatchedProperty,
    };
  }

  // Task 3.3 — "what's flagged / needs review" is a recency-flavoured list
  // like LAST_TRANSACTIONS, so it gets the same all-time-unless-stated
  // default: a flag raised two months ago shouldn't quietly disappear from
  // this list just because no period was mentioned.
  if (/\bflag(ged)?\b/.test(lower) && /\b(transaction|transactions|entries|entry|review)\b/.test(lower)) {
    const recencyPeriod = (explicitPeriod || explicitMonth) ? period : QUERY_PERIODS.ALL_TIME;
    const showAllFlagged = detectAllRequested(lower);
    return buildRequest({ queryType: QUERY_TYPES.FLAGGED_TRANSACTIONS, period: recencyPeriod, property: propertyMatch, category: null, limit: showAllFlagged ? MAX_TRANSACTIONS_LIMIT : limit, showAll: showAllFlagged, confidence: 0.95, reasoning: 'Matched flagged transactions pattern.', month: explicitMonth?.month, year: explicitMonth?.year });
  }

  // BUG FIX (manual WhatsApp testing): "Send me all the transactions I made
  // today/yesterday" only ever said "all", never "last"/"recent", so it
  // never matched this rule at all and fell through to the AI path with no
  // deterministic guardrail. Added "all" alongside "last"/"recent" as an
  // equally valid recency-list trigger.
  if (/\b(last|recent|all)\b/.test(lower) && /\b(transaction|transactions|entries|entry)\b/.test(lower)) {
    // "Last N transactions" is a recency request, not a calendar-window
    // one. Falling through to the general `period` default (THIS_MONTH)
    // would silently drop older transactions from an unscoped request —
    // e.g. "show me my last 5 transactions" could come back with only 2
    // if the other 3 happened last month, with nothing but a small
    // scope footer to explain why. Whether or not a property is also
    // named, default to all time unless the user actually stated a
    // period or month; that's what "last N" means on its own.
    const recencyPeriod = (explicitPeriod || explicitMonth) ? period : QUERY_PERIODS.ALL_TIME;
    // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): "all" used to
    // fall straight through to the default limit (5) exactly like an
    // unscoped request, so "list all my transactions today" and "show me
    // my transactions today" (no count at all) returned identical,
    // silently-truncated 5-item lists. showAll requests the hard max
    // (MAX_TRANSACTIONS_LIMIT, mirrored in QueryRepository's own cap) and
    // tells the formatter this is genuinely "everything," not "the 5 most
    // recent," so the reply header and wording are accurate either way.
    const showAll = detectAllRequested(lower);
    return buildRequest({
      queryType: QUERY_TYPES.LAST_TRANSACTIONS,
      period: recencyPeriod,
      property: propertyMatch,
      category: null,
      limit: showAll ? MAX_TRANSACTIONS_LIMIT : limit,
      showAll,
      confidence: 0.95,
      reasoning: 'Matched last transactions pattern.',
      month: explicitMonth?.month,
      year: explicitMonth?.year,
    });
  }

  if (/\b(biggest|largest|highest)\b/.test(lower) && /\b(expense|spent|spending)\b/.test(lower)) {
    // Same ambiguity as TOTAL_EXPENSES ("how much did I spend?") — ask
    // instead of silently assuming "this month" when nothing scopes it.
    if (vagueScope && !propertyMatch) return scopeClarificationRequest({ queryType: QUERY_TYPES.BIGGEST_EXPENSE });
    return buildRequest({ queryType: QUERY_TYPES.BIGGEST_EXPENSE, period, property: propertyMatch, category: null, limit: 1, confidence: 0.95, reasoning: 'Matched biggest expense pattern.', month: explicitMonth?.month, year: explicitMonth?.year });
  }

  if (category && (/\b(spent|spend|spending|expenses?|on)\b/.test(lower) || /\bby category\b/.test(lower))) {
    return buildRequest({ queryType: QUERY_TYPES.EXPENSES_BY_CATEGORY, period, property: propertyMatch, category, limit: null, confidence: 0.9, reasoning: 'Matched expenses by category pattern.' });
  }

  if (/\bby category\b/.test(lower) || /\bexpenses? by\b/.test(lower)) {
    return buildRequest({ queryType: QUERY_TYPES.EXPENSES_BY_CATEGORY, period, property: propertyMatch, category: category || null, limit: null, confidence: 0.85, reasoning: 'Matched expenses grouped by category.' });
  }

  if (propertyMatch && (/\b(summary|totals?|overview|breakdown)\b/.test(lower) || (/\bincome\b/.test(lower) && /\bexpense/.test(lower)))) {
    return buildRequest({ queryType: QUERY_TYPES.PROPERTY_SUMMARY, period, property: propertyMatch, category: null, limit: null, confidence: 0.9, reasoning: 'Matched property summary pattern.' });
  }

  if (/\bnet\b/.test(lower)) {
    if (vagueScope && !propertyMatch) return scopeClarificationRequest({ queryType: QUERY_TYPES.NET_INCOME });
    return buildRequest({ queryType: propertyMatch ? QUERY_TYPES.PROPERTY_SUMMARY : QUERY_TYPES.NET_INCOME, period, property: propertyMatch, category: null, limit: null, confidence: 0.92, reasoning: 'Matched net income pattern.', month: explicitMonth?.month, year: explicitMonth?.year });
  }

  if (/\b(income|received|generated|rent|earning|earnings)\b/.test(lower) && !/\b(expense|spent|spending)\b/.test(lower)) {
    if (vagueScope && !propertyMatch) return scopeClarificationRequest({ queryType: QUERY_TYPES.TOTAL_INCOME, category: detectIncomeTopic(lower) });
    return buildRequest({
      queryType: QUERY_TYPES.TOTAL_INCOME,
      period,
      property: propertyMatch,
      category: detectIncomeTopic(lower),
      limit: null,
      confidence: propertyMatch ? 0.93 : 0.88,
      reasoning: detectIncomeTopic(lower) === 'rent' ? 'Matched rent income pattern.' : 'Matched total income pattern.',
      month: explicitMonth?.month,
      year: explicitMonth?.year,
    });
  }

  if (/\b(expense|expenses|spent|spend|spending|paid out)\b/.test(lower)) {
    if (vagueScope && !propertyMatch) return scopeClarificationRequest({ queryType: QUERY_TYPES.TOTAL_EXPENSES });
    return buildRequest({ queryType: QUERY_TYPES.TOTAL_EXPENSES, period, property: propertyMatch, category: null, limit: null, confidence: 0.9, reasoning: 'Matched total expenses pattern.', month: explicitMonth?.month, year: explicitMonth?.year });
  }

  if (propertyMatch && /\b(how much|total|for)\b/.test(lower)) {
    return buildRequest({ queryType: QUERY_TYPES.PROPERTY_SUMMARY, period, property: propertyMatch, category: null, limit: null, confidence: 0.8, reasoning: 'Matched property how-much pattern.' });
  }

  return null;
}

function normalizeAiInterpretation(raw, knownProperties, _referenceDate, lower = '') {
  if (!raw || typeof raw !== 'object') return unknownRequest('Malformed AI interpretation.');

  const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  if (confidence === null || confidence < 0.7) return unknownRequest('Low or invalid interpretation confidence.');

  const queryType = String(raw.queryType || '').trim().toUpperCase();
  if (!Object.values(QUERY_TYPES).includes(queryType) || queryType === QUERY_TYPES.UNKNOWN) {
    return unknownRequest('Unsupported or unknown query type from AI.');
  }

  const period = normalizePeriod(raw.period);
  const property = raw.property && String(raw.property).trim() ? resolveProperty(String(raw.property), knownProperties) : { property: null, status: 'none', candidates: [] };

  // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): the same "all"
  // vs "default 5" gap applies here too — the AI path has its own limit
  // normalization (normalizeLimit) with no notion of "all" either, so an
  // "all"-worded request that missed the deterministic rule above (e.g.
  // unusual phrasing routed to the AI) would silently get the same
  // default-5 cap. Applied only to the two query types that actually list
  // individual rows.
  const showAll = (queryType === QUERY_TYPES.LAST_TRANSACTIONS || queryType === QUERY_TYPES.FLAGGED_TRANSACTIONS)
    && detectAllRequested(lower);
  const resolvedLimit = showAll ? MAX_TRANSACTIONS_LIMIT : normalizeLimit(raw.limit);

  if (raw.property && String(raw.property).trim() && property.status !== 'matched') {
    return {
      ...buildRequest({ queryType, period, property: null, category: normalizeCategory(raw.category), limit: resolvedLimit, showAll, confidence, reasoning: 'Property mentioned but not matched.' }),
      unmatchedProperty: String(raw.property).trim(), source: 'ai'
    };
  }

  return { ...buildRequest({ queryType, period, property: property.status === 'matched' ? property.property : null, category: normalizeCategory(raw.category), limit: resolvedLimit, showAll, confidence, reasoning: raw.reasoning || 'AI interpretation.' }), source: 'ai' };
}

// Returns null (rather than defaulting to THIS_MONTH) when the text doesn't
// explicitly say a period — this is what lets `vagueScope` above tell "this
// month" (explicit) apart from a bare "how much did I spend?" (nothing
// explicit, would otherwise silently default).
function detectExplicitPeriod(lower) {
  // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): "today" and
  // "yesterday" fell through every branch here (there was no case for
  // either), so a request like "transactions I made yesterday" carried NO
  // explicit period at all and got treated identically to an unscoped
  // request — which, for LAST_TRANSACTIONS, defaults to ALL_TIME/whatever
  // the AI happened to guess, not an actual yesterday-only filter. Checked
  // before "this week" so nothing here can shadow it.
  if (/\byesterday\b/.test(lower)) return QUERY_PERIODS.YESTERDAY;
  if (/\btoday\b/.test(lower)) return QUERY_PERIODS.TODAY;
  if (/\bthis week\b/.test(lower) || /\bcurrent week\b/.test(lower)) return QUERY_PERIODS.THIS_WEEK;
  if (/\bthis month\b/.test(lower) || /\bcurrent month\b/.test(lower)) return QUERY_PERIODS.THIS_MONTH;
  if (/\bthis year\b/.test(lower) || /\bcurrent year\b/.test(lower)) return QUERY_PERIODS.THIS_YEAR;
  return null;
}

// QUERY_PERIODS only represents relative windows (this week/month/year, all
// time) — there's no enum value for "July" specifically. An explicit
// calendar month (with or without a year) is carried separately as
// { month, year } on the request and takes priority over `period` in
// QueryRepository. Reuses the same month-name table the statement flow
// already relies on, so "July"/"july"/etc. are recognized identically in
// both places. A month without a year assumes the current Lagos year —
// the same assumption a person would make saying "for July" out loud.
function detectExplicitMonth(lower, referenceDate) {
  let month = null;
  for (const [token, value] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(lower)) {
      month = value;
      break;
    }
  }
  if (!month) return null;

  const yearMatch = /\b(20\d{2})\b/.exec(lower);
  const year = yearMatch ? Number(yearMatch[1]) : Number(getLagosDateString(referenceDate || new Date()).slice(0, 4));
  return { month, year };
}

function detectProperty(lower, knownProperties) {
  // Prefer a strict match on an explicit "for X" mention first — same
  // reasoning as StatementRequestInterpreter's matchKnownProperty: a raw
  // substring scan across the whole message would silently match "Orchid"
  // inside "Orchid House", attributing the answer to the wrong property.
  // resolveProperty requires an exact canonicalized match, so it correctly
  // rejects "orchid house" while still matching "orchid", "flat 2", etc.
  const forMatch = /\bfor\s+([a-z0-9][a-z0-9\s]{0,40}?)$/i.exec(lower);
  if (forMatch) {
    const resolved = resolveProperty(forMatch[1].trim(), knownProperties);
    if (resolved.status === 'matched') {
      return { status: 'matched', property: resolved.property };
    }
    if (resolved.status === 'ambiguous') {
      return { status: 'unmatched', unmatchedProperty: forMatch[1].trim() };
    }
    // status 'none' falls through — "for July" etc. isn't a property mention at all.
  }

  let best = null;
  for (const property of knownProperties || []) {
    const labels = [property.name, ...(property.aliases || [])];
    for (const label of labels) {
      const needle = String(label || "").toLowerCase().trim();
      if (!needle) continue;
      const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i");
      if (pattern.test(lower) && (!best || needle.length > best.len)) best = { property: { id: String(property.id), name: property.name }, len: needle.length };
    }
  }
  if (best) return { status: "matched", property: best.property };
  const unknownMatch = /\b(?:apartment|apt|flat|unit|property)\s+[a-z0-9-]+\b/i.exec(lower);
  if (unknownMatch) return { status: "unmatched", unmatchedProperty: unknownMatch[0] };
  return { status: "none", property: null };
}

function detectCategory(lower) {
  const categories = ['repairs', 'repair', 'maintenance', 'cleaning', 'security', 'plumbing', 'electric', 'electrical', 'utilities', 'service charge'];
  for (const category of categories) {
    if (lower.includes(category)) return (category === 'repair') ? 'repairs' : (category === 'electric' || category === 'electrical') ? 'electrical' : category;
  }
  const onMatch = /\bon\s+([a-z][a-z\s]{1,30})$/i.exec(lower);
  if (onMatch && !/\bon\s+(this|the|my|a|an)\b/.test(lower)) {
    const value = onMatch[1].trim();
    if (!/(month|week|year|apartment|apt|property)/.test(value)) return value;
  }
  return null;
}

function detectLimit(lower) {
  const match = /\blast\s+(\d{1,2})\b/.exec(lower);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

// BUG FIX (manual WhatsApp testing, 🔴 — confirmed live): "list all my
// transactions for today/yesterday" always came back capped at
// env.queryLastN (5), identically to a plain "last transactions" request
// with no count at all — "all" was never actually distinguished from "no
// count given" anywhere in the pipeline, so it silently got the same
// default-5 treatment. detectLimit only ever recognized a literal number
// ("last 3"); it had no concept of "all" meaning "no cap." This is checked
// as its own signal so "all" and an explicit number can't be confused.
function detectAllRequested(lower) {
  return /\ball\b/.test(lower) && !/\ball\s+time\b/.test(lower);
}

function normalizePeriod(value) {
  const period = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  return Object.values(QUERY_PERIODS).includes(period) ? period : QUERY_PERIODS.THIS_MONTH;
}

function normalizeCategory(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function detectIncomeTopic(lower) {
  if (/\brent\b/.test(lower) || /\bcame in\b/.test(lower) || /\bcollect\b/.test(lower) || /\bpayment\b/.test(lower)) {
    return 'rent';
  }
  return null;
}

function normalizeLimit(value) {
  return (typeof value === 'number' && value > 0) ? Math.min(Math.floor(value), 50) : env.queryLastN;
}

function buildRequest({ queryType, period, property, category, limit, confidence, reasoning, month, year, showAll = false }) {
  return {
    queryType,
    period: period || QUERY_PERIODS.THIS_MONTH,
    property: property || null,
    category: category || null,
    limit: limit ?? env.queryLastN,
    confidence: confidence ?? 1,
    reasoning: reasoning || '',
    month: month || null,
    year: year || null,
    // BUG FIX (manual WhatsApp testing): lets QueryRepository/QueryFormatter
    // tell "genuinely everything, capped only by the hard max" apart from
    // "the default 5 most recent" — see the LAST_TRANSACTIONS branch above
    // and formatQueryResult's 'last_transactions' case.
    showAll,
  };
}

function unknownRequest(reasoning) {
  return { queryType: QUERY_TYPES.UNKNOWN, period: QUERY_PERIODS.ALL_TIME, property: null, category: null, limit: env.queryLastN, confidence: 0, reasoning, source: 'none' };
}

// N: distinct from unknownRequest — the query WAS understood (e.g. "how
// much did I spend?"), it's just unscoped. QueryManager checks
// needsScopeClarification before the generic UNKNOWN handling so this gets
// its own targeted reply instead of the "Could Not Understand" fallback.
// pendingQueryType/pendingCategory carry what the query WOULD resolve to
// once scope is known, so QueryManager can persist it (PendingQuery) and
// a short follow-up like "for July" can complete the original question
// instead of being reclassified from nothing.
function scopeClarificationRequest({ queryType, category = null } = {}) {
  return {
    queryType: QUERY_TYPES.UNKNOWN,
    period: QUERY_PERIODS.ALL_TIME,
    property: null,
    category: null,
    limit: env.queryLastN,
    confidence: 1,
    reasoning: 'Query is broad; asked for scope instead of assuming a default.',
    needsScopeClarification: true,
    pendingQueryType: queryType || null,
    pendingCategory: category || null,
  };
}

// Used by QueryManager to interpret a short follow-up answer to the scope
// question ("for July", "this year", "Flat 2") on its own — without
// requiring it to independently re-state a full query type.
export function resolveScopeAnswer(text, knownProperties = [], referenceDate = new Date()) {
  const lower = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const period = detectExplicitPeriod(lower);
  const explicitMonth = detectExplicitMonth(lower, referenceDate);
  const propertyDetection = detectProperty(lower, knownProperties || []);
  const property = propertyDetection.status === 'matched' ? propertyDetection.property : null;
  const unmatchedProperty = propertyDetection.status === 'unmatched' ? propertyDetection.unmatchedProperty : null;
  return {
    period,
    property,
    unmatchedProperty,
    month: explicitMonth?.month || null,
    year: explicitMonth?.year || null,
  };
}

// Async wrapper: tries the free, deterministic parse first; only calls the
// AI when that finds absolutely nothing (no period/month/property keyword
// at all). Deliberately narrow — it extracts ONLY scope (period/month/year/
// property), never a queryType, so it can't accidentally reclassify the
// original pending question into something else. A propertyName from the
// AI must exactly match a known property or it's treated as unmatched, the
// same "never guess" rule applied everywhere else in this app.
export async function resolveScopeAnswerAsync(text, { knownProperties = [], referenceDate = new Date(), aiService } = {}) {
  const deterministic = resolveScopeAnswer(text, knownProperties, referenceDate);
  if (deterministic.period || deterministic.property || deterministic.month || deterministic.unmatchedProperty) {
    return { ...deterministic, source: 'deterministic' };
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { ...deterministic, source: 'deterministic' };

  const service = aiService || createAIService({
    model: getGeminiQueryModel() || env.geminiQueryModel || env.geminiClassifierModel,
  });

  try {
    const raw = await service.completeJson({
      system: buildScopeAnswerSystemPrompt((knownProperties || []).map((p) => p.name)),
      user: trimmed,
      schemaHint: SCOPE_ANSWER_SCHEMA_HINT,
    });
    return { ...normalizeAiScopeAnswer(raw, knownProperties, referenceDate), source: 'ai' };
  } catch (err) {
    if (isAiUnavailableError(err)) {
      return { ...deterministic, aiUnavailable: true, source: 'ai_unavailable' };
    }
    return { ...deterministic, source: 'ai_failed' };
  }
}

function buildScopeAnswerSystemPrompt(propertyNames) {
  const propertyList = propertyNames.length ? propertyNames.map((name) => `- ${name}`).join('\n') : '- (none)';
  return `A bookkeeping assistant asked the user: "Do you want this for this month, this year, or for a specific property?"
The user's reply follows. Extract ONLY what they specified — never guess or invent anything not stated.

KNOWN PROPERTIES (propertyName must match one of these exactly, or be null):
${propertyList}

Return ONLY raw JSON, no markdown:
{ "period": "today"|"yesterday"|"this_week"|"this_month"|"this_year"|null, "month": 1-12|null, "year": 2000-2100|null, "propertyName": "<exact known property name>"|null }

Rules:
- If they named a specific calendar month (e.g. "July", "last July"), set month (and year if given) and leave period null.
- If they said a relative period ("this month", "this year", "this week"), set period and leave month/year null.
- If they named a property, propertyName must be an EXACT match from the list above — never invent or fuzzy-match one.
- If their reply doesn't clearly answer the scope question, return all fields null.`;
}

const SCOPE_ANSWER_SCHEMA_HINT = `{ "period": "this_month", "month": null, "year": null, "propertyName": null }`;

function normalizeAiScopeAnswer(raw, knownProperties, referenceDate) {
  if (!raw || typeof raw !== 'object') {
    return { period: null, property: null, month: null, year: null, unmatchedProperty: null };
  }

  const period = Object.values(QUERY_PERIODS).includes(raw.period) && raw.period !== QUERY_PERIODS.ALL_TIME ? raw.period : null;

  let month = Number.isInteger(raw.month) && raw.month >= 1 && raw.month <= 12 ? raw.month : null;
  let year = Number.isInteger(raw.year) && raw.year >= 2000 && raw.year <= 2100 ? raw.year : null;
  if (month && !year) {
    year = Number(getLagosDateString(referenceDate || new Date()).slice(0, 4));
  }
  if (!month) year = null;

  let property = null;
  let unmatchedProperty = null;
  if (typeof raw.propertyName === 'string' && raw.propertyName.trim()) {
    const match = (knownProperties || []).find(
      (p) => String(p.name).toLowerCase().trim() === raw.propertyName.toLowerCase().trim(),
    );
    if (match) {
      property = { id: String(match.id), name: match.name };
    } else {
      unmatchedProperty = raw.propertyName.trim();
    }
  }

  return { period, property, month, year, unmatchedProperty };
}

function aiUnavailableRequest(reasoning) {
  return { ...unknownRequest(reasoning), aiUnavailable: true };
}

export default { interpretQuery, QUERY_TYPES };
