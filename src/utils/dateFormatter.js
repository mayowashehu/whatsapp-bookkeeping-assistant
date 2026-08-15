/**
 * Reusable Africa/Lagos date display helpers.
 */

export function formatLagosDisplayDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatLagosMonthYear(year, month) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export default {
  formatLagosDisplayDate,
  formatLagosMonthYear,
};
