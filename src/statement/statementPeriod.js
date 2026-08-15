import { toLagosNoonDate } from '../services/query/queryPeriod.js';
import { formatLagosMonthYear } from '../utils/dateFormatter.js';

/**
 * Converts a calendar month in Africa/Lagos into inclusive start/end bounds.
 *
 * @param {number} year
 * @param {number} month 1-12
 */
export function resolveCalendarMonthBounds(year, month) {
  const y = Number(year);
  const m = Number(month);

  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new Error('year must be a valid integer');
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error('month must be an integer from 1 to 12');
  }

  const startYmd = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endYmd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return {
    year: y,
    month: m,
    startDate: new Date(`${startYmd}T00:00:00+01:00`),
    endDate: new Date(`${endYmd}T23:59:59.999+01:00`),
    startYmd,
    endYmd,
    label: formatLagosMonthYear(y, m),
    // noon markers available when needed by other helpers
    startNoon: toLagosNoonDate(startYmd),
    endNoon: toLagosNoonDate(endYmd),
  };
}

export default {
  resolveCalendarMonthBounds,
};
