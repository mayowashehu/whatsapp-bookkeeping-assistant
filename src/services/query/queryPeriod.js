import {
  addDaysToYmd,
  getLagosDateString,
  normalizeTransactionDate,
} from '../../ai/parsing/TransactionNormalizer.js';

export const QUERY_PERIODS = Object.freeze({
  ALL_TIME: 'all_time',
  // BUG FIX (manual WhatsApp testing, 🔴 — confirmed live: "today" and
  // "yesterday" queries came back with identical results and a "Period:
  // this week" label, because there was previously no day-level period at
  // all — every single-day request silently collapsed into the nearest
  // enum value the AI could pick, THIS_WEEK, for both "today" and
  // "yesterday" alike. TODAY/YESTERDAY are now first-class periods with
  // their own single-day bounds below.
  TODAY: 'today',
  YESTERDAY: 'yesterday',
  THIS_WEEK: 'this_week',
  THIS_MONTH: 'this_month',
  THIS_YEAR: 'this_year',
});

/**
 * Resolves a period key into optional Mongo date bounds (Africa/Lagos calendar).
 * Bounds are start of first day (00:00:00.000+01:00) to end of last day (23:59:59.999+01:00) inclusive.
 *
 * @returns {{ period: string, startDate: Date|null, endDate: Date|null, label: string }}
 */
export function resolvePeriodBounds(period = QUERY_PERIODS.ALL_TIME, referenceDate = new Date()) {
  const today = getLagosDateString(referenceDate);

  if (!period || period === QUERY_PERIODS.ALL_TIME) {
    return {
      period: QUERY_PERIODS.ALL_TIME,
      startDate: null,
      endDate: null,
      label: 'all time',
    };
  }

  if (period === QUERY_PERIODS.THIS_MONTH) {
    const start = `${today.slice(0, 8)}01`;
    const [year, month] = today.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const end = `${today.slice(0, 8)}${String(lastDay).padStart(2, '0')}`;
    return {
      period,
      startDate: startOfLagosDay(start),
      endDate: endOfLagosDay(end),
      label: 'this month',
    };
  }

  if (period === QUERY_PERIODS.THIS_YEAR) {
    const start = `${today.slice(0, 4)}-01-01`;
    const end = `${today.slice(0, 4)}-12-31`;
    return {
      period,
      startDate: startOfLagosDay(start),
      endDate: endOfLagosDay(end),
      label: 'this year',
    };
  }

  if (period === QUERY_PERIODS.TODAY) {
    return {
      period,
      startDate: startOfLagosDay(today),
      endDate: endOfLagosDay(today),
      label: 'today',
    };
  }

  if (period === QUERY_PERIODS.YESTERDAY) {
    const yesterday = addDaysToYmd(today, -1);
    return {
      period,
      startDate: startOfLagosDay(yesterday),
      endDate: endOfLagosDay(yesterday),
      label: 'yesterday',
    };
  }

  if (period === QUERY_PERIODS.THIS_WEEK) {
    const [year, month, day] = today.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
    const daysFromMonday = (weekday + 6) % 7; // Monday-start week
    const start = addDaysToYmd(today, -daysFromMonday);
    const end = addDaysToYmd(start, 6);
    return {
      period,
      startDate: startOfLagosDay(start),
      endDate: endOfLagosDay(end),
      label: 'this week',
    };
  }

  return {
    period: QUERY_PERIODS.ALL_TIME,
    startDate: null,
    endDate: null,
    label: 'all time',
  };
}

export function startOfLagosDay(ymd) {
  return new Date(`${String(ymd)}T00:00:00.000+01:00`);
}

export function endOfLagosDay(ymd) {
  return new Date(`${String(ymd)}T23:59:59.999+01:00`);
}

export function toLagosNoonDate(isoDate, referenceDate = new Date()) {
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

  const parsedDate = new Date(`${textDate}T12:00:00+01:00`);
  return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
}

export default {
  QUERY_PERIODS,
  resolvePeriodBounds,
  toLagosNoonDate,
  startOfLagosDay,
  endOfLagosDay,
};
