/**
 * Exponential backoff retry for transient HTTP failures (429 and 5xx only).
 *
 * @param {() => Promise<{ ok: boolean, status: number, payload?: any, error?: object }>} operation
 * @param {{ maxRetries?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export async function retryRequest(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep =
    options.sleep ||
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));

  let attempt = 0;
  let lastResult;

  while (attempt <= maxRetries) {
    lastResult = await operation(attempt);

    if (lastResult.ok) {
      return lastResult;
    }

    const status = lastResult.status;
    const transient = status === 429 || (status >= 500 && status <= 599);

    if (!transient || attempt === maxRetries) {
      return lastResult;
    }

    const delay = baseDelayMs * 2 ** attempt;
    await sleep(delay);
    attempt += 1;
  }

  return lastResult;
}

export function isTransientHttpStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export default {
  retryRequest,
  isTransientHttpStatus,
};
