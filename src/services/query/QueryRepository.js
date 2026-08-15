import mongoose from 'mongoose';
import Entry from '../../models/Entry.js';
import Property from '../../models/Property.js';
import { resolvePeriodBounds } from './queryPeriod.js';
import { resolveCalendarMonthBounds } from '../../statement/statementPeriod.js';

/**
 * Read-only MongoDB queries/aggregations for confirmed entries only.
 * No formatting.
 */
export async function executeQuery(request, senderId) {
  if (!senderId) {
    throw new Error('senderId is required for executeQuery');
  }

  if (request.queryType === 'LIST_PROPERTIES') {
    const properties = await Property.find({ senderId, active: { $ne: false } }).select('name aliases').lean();
    return {
      kind: 'list_properties',
      properties,
      request,
    };
  }

  const periodBounds = request.month && request.year
    ? resolveCalendarMonthBounds(request.year, request.month)
    : resolvePeriodBounds(request.period);
  const match = buildMatch(request, periodBounds, senderId);

  switch (request.queryType) {
    case 'TOTAL_INCOME': {
      const incomeMatch = buildIncomeMatch(match, request);
      const [total, propertyCount] = await Promise.all([
        sumAmount(incomeMatch),
        request.property?.id ? Promise.resolve(null) : countDistinctProperties(incomeMatch),
      ]);
      return { kind: 'total', type: 'income', total, propertyCount, periodBounds, request };
    }
    case 'TOTAL_EXPENSES': {
      const expenseMatch = { ...match, type: 'expense' };
      const [total, propertyCount] = await Promise.all([
        sumAmount(expenseMatch),
        request.property?.id ? Promise.resolve(null) : countDistinctProperties(expenseMatch),
      ]);
      return { kind: 'total', type: 'expense', total, propertyCount, periodBounds, request };
    }
    case 'NET_INCOME':
    case 'PORTFOLIO_SUMMARY': {
      const income = await sumAmount(buildIncomeMatch(match, request));
      const expenses = await sumAmount({ ...match, type: 'expense' });
      return {
        kind: request.queryType === 'PORTFOLIO_SUMMARY' ? 'portfolio_summary' : 'net',
        income,
        expenses,
        net: income - expenses,
        periodBounds,
        request,
      };
    }
    case 'EXPENSES_BY_CATEGORY':
      return {
        kind: 'expenses_by_category',
        rows: await aggregateExpensesByCategory(match, request.category),
        periodBounds,
        request,
      };
    case 'LAST_TRANSACTIONS':
      return {
        kind: 'last_transactions',
        rows: await findLastTransactions(match, request.limit),
        periodBounds,
        request,
      };
    case 'FLAGGED_TRANSACTIONS':
      return {
        kind: 'flagged_transactions',
        rows: await findFlaggedTransactions(match, request.limit),
        periodBounds,
        request,
      };
    case 'PROPERTY_SUMMARY': {
      const income = await sumAmount({ ...match, type: 'income' });
      const expenses = await sumAmount({ ...match, type: 'expense' });
      return {
        kind: 'property_summary',
        income,
        expenses,
        net: income - expenses,
        periodBounds,
        request,
      };
    }
    case 'BIGGEST_EXPENSE':
      return {
        kind: 'biggest_expense',
        entry: await findBiggestExpense(match),
        periodBounds,
        request,
      };
    default:
      return {
        kind: 'unknown',
        periodBounds,
        request,
      };
  }
}

function buildMatch(request, periodBounds, senderId) {
  const match = {
    status: 'confirmed',
    senderId,
  };

  if (request.property?.id) {
    match.property = new mongoose.Types.ObjectId(request.property.id);
  }

  if (periodBounds.startDate || periodBounds.endDate) {
    match.transactionDate = {};
    if (periodBounds.startDate) {
      match.transactionDate.$gte = periodBounds.startDate;
    }
    if (periodBounds.endDate) {
      match.transactionDate.$lte = periodBounds.endDate;
    }
  }

  return match;
}

function buildIncomeMatch(baseMatch, request) {
  // For all income queries, start with base filters and type: 'income'
  const coreMatch = {
    ...baseMatch,
    type: 'income',
  };

  // If it's a rent-focused query, broaden with OR conditions
  if (isRentIncomeQuery(request)) {
    return {
      ...baseMatch, // Keep base filters (senderId, period, property)
      $or: [
        { type: 'income' }, // Still match all income
        { category: /rent/i },
        { description: /(rent|payment)/i },
      ],
    };
  }

  return coreMatch;
}

function isRentIncomeQuery(request) {
  const category = String(request?.category || '').trim().toLowerCase();
  const reasoning = String(request?.reasoning || '').trim().toLowerCase();
  return category === 'rent' || reasoning.includes('rent');
}

async function sumAmount(match) {
  const rows = await Entry.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return rows[0]?.total || 0;
}

async function countDistinctProperties(match) {
  const rows = await Entry.aggregate([
    { $match: match },
    { $group: { _id: '$property' } },
    { $count: 'count' },
  ]);
  return rows[0]?.count || 0;
}

async function aggregateExpensesByCategory(match, category) {
  const categoryMatch = {
    ...match,
    type: 'expense',
  };
  if (category) {
    categoryMatch.category = new RegExp(`^${escapeRegex(category)}$`, 'i');
  }

  return Entry.aggregate([
    { $match: categoryMatch },
    {
      $group: {
        _id: { $toLower: '$category' },
        total: { $sum: '$amount' },
        category: { $first: '$category' },
      },
    },
    { $sort: { total: -1 } },
  ]);
}

async function findLastTransactions(match, limit) {
  const n = Math.max(1, Math.min(Number(limit) || 5, 50));
  return Entry.find(match)
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(n)
    .populate('property', 'name')
    .lean();
}

// Task 3.3 — sorted by flaggedAt (most recently flagged first) rather than
// transactionDate: a review list is about what needs attention SOON, which
// tracks when it was raised, not when the underlying transaction happened.
async function findFlaggedTransactions(match, limit) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 50));
  return Entry.find({ ...match, flaggedForReview: true })
    .sort({ flaggedAt: -1, transactionDate: -1 })
    .limit(n)
    .populate('property', 'name')
    .lean();
}

async function findBiggestExpense(match) {
  return Entry.findOne({ ...match, type: 'expense' })
    .sort({ amount: -1, transactionDate: -1 })
    .populate('property', 'name')
    .lean();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  executeQuery,
};
