import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './src/config/db.js';
import Entry from './src/models/Entry.js';
import { executeQuery } from './src/services/query/QueryRepository.js';
import { QUERY_PERIODS, resolvePeriodBounds } from './src/services/query/queryPeriod.js';

const bounds = resolvePeriodBounds(QUERY_PERIODS.THIS_MONTH, new Date('2026-07-22T12:00:00+01:00'));
console.log(
  'BOUNDS',
  JSON.stringify({
    startDate: bounds.startDate.toISOString(),
    endDate: bounds.endDate.toISOString(),
    label: bounds.label,
  }),
);

try {
  await connectDatabase();

  const senders = await Entry.aggregate([
    {
      $match: {
        status: 'confirmed',
        transactionDate: {
          $gte: bounds.startDate,
          $lte: bounds.endDate,
        },
      },
    },
    {
      $group: {
        _id: '$senderId',
        incomeCount: {
          $sum: {
            $cond: [{ $eq: ['$type', 'income'] }, 1, 0],
          },
        },
        totalIncome: {
          $sum: {
            $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0],
          },
        },
      },
    },
    { $sort: { totalIncome: -1 } },
    { $limit: 5 },
  ]);

  console.log('SENDERS', JSON.stringify(senders));

  const target = senders.find((row) => row.incomeCount > 0)?._id;
  if (!target) {
    console.log('NO_SENDER_WITH_INCOME_THIS_MONTH');
    const allTimeSenders = await Entry.aggregate([
      {
        $match: {
          status: 'confirmed',
        },
      },
      {
        $group: {
          _id: '$senderId',
          incomeCount: {
            $sum: {
              $cond: [{ $eq: ['$type', 'income'] }, 1, 0],
            },
          },
          totalIncome: {
            $sum: {
              $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0],
            },
          },
        },
      },
      { $sort: { totalIncome: -1 } },
      { $limit: 5 },
    ]);

    console.log('ALL_TIME_SENDERS', JSON.stringify(allTimeSenders));

    const fallbackTarget = allTimeSenders.find((row) => row.incomeCount > 0)?._id;
    if (fallbackTarget) {
      const fallbackResult = await executeQuery(
        {
          queryType: 'TOTAL_INCOME',
          period: 'all_time',
          property: null,
          category: 'rent',
          reasoning: 'Matched rent income pattern.',
        },
        fallbackTarget,
      );
      console.log(
        'FALLBACK_QUERY_RESULT',
        JSON.stringify({
          senderId: fallbackTarget,
          total: fallbackResult.total,
          kind: fallbackResult.kind,
          period: fallbackResult.periodBounds.label,
        }),
      );
    }
  } else {
    const result = await executeQuery(
      {
        queryType: 'TOTAL_INCOME',
        period: 'this_month',
        property: null,
        category: 'rent',
        reasoning: 'Matched rent income pattern.',
      },
      target,
    );

    console.log(
      'QUERY_RESULT',
      JSON.stringify({
        senderId: target,
        total: result.total,
        kind: result.kind,
        period: result.periodBounds.label,
      }),
    );
  }
} finally {
  await disconnectDatabase();
  await mongoose.disconnect();
}
