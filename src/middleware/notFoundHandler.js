/**
 * Handles requests that matched no route.
 */
export function notFoundHandler(req, res, next) {
  const error = new Error(`Not Found — ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}
