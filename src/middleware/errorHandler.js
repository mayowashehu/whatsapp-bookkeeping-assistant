import env from '../config/env.js';

/**
 * Centralized Express error handler.
 * Must be registered after all routes.
 * The unused `_next` parameter is required so Express treats this as an error middleware.
 */
export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || 'Internal Server Error';

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(env.nodeEnv === 'development' && err.stack ? { stack: err.stack } : {}),
  });
}
