export function normalizePhoneNumber(raw) {
  if (!raw) return null;
  return String(raw).replace(/\D/g, ''); // digits only, no +, spaces, dashes
}