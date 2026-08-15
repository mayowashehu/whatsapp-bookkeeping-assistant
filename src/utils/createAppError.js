/**
 * Structured application error with a stable machine-readable code.
 */
export function createAppError(code, message, { cause, statusCode } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (statusCode) {
    error.statusCode = statusCode;
  }
  return error;
}

export function getErrorCode(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    return err.code;
  }
  return 'UNKNOWN_ERROR';
}
