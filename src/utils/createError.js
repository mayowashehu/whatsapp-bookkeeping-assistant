/**
 * Create a standard application error with an HTTP status code.
 */
export function createError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
