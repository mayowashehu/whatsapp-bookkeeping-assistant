/**
 * Health check controller — no business logic.
 */
export function getHealth(_req, res) {
  res.status(200).json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}
