// Delays between attempts for idempotent calls; tests shorten them.
export const retryPolicy = { delaysMs: [2_000, 8_000] };

export class HttpError extends Error {
  constructor(service, status, body) {
    super(`${service}: HTTP ${status}${body ? `: ${body}` : ''}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryable = (error) => !(error instanceof HttpError) || error.status === 429 || error.status >= 500;

// Error messages never include the URL: Bitrix webhook URLs carry the access token.
async function attempt(service, url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 }) {
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = error.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(`${service}: request failed: ${error.message}${code}`);
  }

  const text = await response.text();
  if (!response.ok) throw new HttpError(service, response.status, text.slice(0, 500));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${service}: response is not JSON: ${text.slice(0, 200)}`);
  }
}

// `retry: true` only for idempotent requests: reads, Gmail label changes, AI calls.
export async function requestJson(service, url, options = {}) {
  const delays = options.retry ? retryPolicy.delaysMs : [];
  for (let i = 0; ; i++) {
    try {
      return await attempt(service, url, options);
    } catch (error) {
      if (i >= delays.length || !isRetryable(error)) throw error;
      await sleep(delays[i]);
    }
  }
}
