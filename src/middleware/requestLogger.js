/**
 * Logs method, path, status, and duration for each request.
 * Kept thin — no business logic.
 */
export function requestLogger(req, res, next) {
  const startedAt = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });

  next();
}
