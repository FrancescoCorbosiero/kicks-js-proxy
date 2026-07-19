import "server-only";

export interface HttpError extends Error {
  status?: number;
  body?: string;
}

export interface RetryPolicy {
  attempts: number; // total tries, including the first
  backoffMs: number; // base; grows exponentially (backoff * 2^n) with jitter
  timeoutMs: number; // per-attempt
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, backoffMs: 500, timeoutMs: 20_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeError(message: string, status?: number, body?: string): HttpError {
  const e = new Error(message) as HttpError;
  e.status = status;
  e.body = body;
  return e;
}

/** Retry on network errors, 429, and 5xx. Honors Retry-After on 429. */
function isRetryable(status?: number): boolean {
  if (status == null) return true; // network/abort
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * fetch with timeout, exponential backoff + jitter, and rate-limit handling.
 * Returns the parsed JSON body (caller validates with Zod). Throws HttpError on
 * non-2xx after exhausting retries.
 */
export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<T> {
  return (await requestJsonWithHeaders<T>(url, init, policy)).data;
}

/**
 * Like requestJson, but also returns the response headers — Woo's REST API
 * reports pagination totals in X-WP-Total / X-WP-TotalPages.
 */
export async function requestJsonWithHeaders<T = unknown>(
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<{ data: T; headers: Headers }> {
  let lastErr: HttpError | undefined;

  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) {
        return { data: (await res.json()) as T, headers: res.headers };
      }
      const body = await res.text().catch(() => "");
      lastErr = makeError(`HTTP ${res.status} for ${url}: ${body.slice(0, 500)}`, res.status, body);

      if (!isRetryable(res.status) || attempt === policy.attempts - 1) throw lastErr;

      const wait = retryAfterMs(res) ?? backoff(policy.backoffMs, attempt);
      await sleep(wait);
    } catch (err) {
      const e =
        (err as HttpError).status != null
          ? (err as HttpError)
          : makeError(`Request to ${url} failed: ${(err as Error).message}`);
      lastErr = e;
      if (!isRetryable(e.status) || attempt === policy.attempts - 1) throw e;
      await sleep(backoff(policy.backoffMs, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? makeError(`Request to ${url} failed`);
}

function backoff(base: number, attempt: number): number {
  const exp = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return exp + jitter;
}

/** Chunk an array into pieces of at most `size` (e.g. KicksDB's 50-item cap). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
