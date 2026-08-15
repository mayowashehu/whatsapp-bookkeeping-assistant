/**
 * Reusable NGN currency formatting for WhatsApp replies and PDF statements.
 */

export function formatNaira(amount, { withSymbol = true } = {}) {
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  const formatted = safe.toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return withSymbol ? `₦${formatted}` : formatted;
}

export function formatNairaPlain(amount) {
  return formatNaira(amount, { withSymbol: true });
}

export default {
  formatNaira,
  formatNairaPlain,
};
