/**
 * Fetch wrapper with AbortController timeout.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'TIMEOUT';
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
