/** Shared timeout, deadline, backoff, and JSON-page retry behavior. */

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_RETRIES = 3;
const JSON_RETRIES = 3;

export interface RegistryRuntime {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

interface RetryOptions extends RegistryRuntime {
  timeoutMs?: number;
  retries?: number;
  label?: string;
  /** Absolute timestamp in the runtime's `now()` clock. */
  deadline?: number;
}

export class RegistryDeadlineError extends Error {
  constructor(label: string) {
    super(`${label}: registry deadline exceeded`);
    this.name = 'RegistryDeadlineError';
  }
}

/** Terminal failure after the transport retry budget has been exhausted. */
export class RegistryTransportError extends Error {
  constructor(label: string, attempts: number, reason: string) {
    super(`${label}: giving up after ${attempts} attempts — ${reason}`);
    this.name = 'RegistryTransportError';
  }
}

function clock(runtime: RegistryRuntime): () => number {
  return runtime.now ?? Date.now;
}

function sleeper(runtime: RegistryRuntime): (ms: number) => Promise<void> {
  return runtime.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function delay(ms: number, runtime: RegistryRuntime = {}): Promise<void> {
  return sleeper(runtime)(ms);
}

function remainingMs(opts: RetryOptions, label: string): number {
  if (opts.deadline === undefined) return Number.POSITIVE_INFINITY;
  const remaining = opts.deadline - clock(opts)();
  if (remaining <= 0) throw new RegistryDeadlineError(label);
  return remaining;
}

export function assertBeforeDeadline(
  deadline: number,
  runtime: RegistryRuntime,
  label: string,
): void {
  remainingMs({ ...runtime, deadline }, label);
}

async function retrySleep(attempt: number, opts: RetryOptions, label: string): Promise<void> {
  const delayMs = 500 * 3 ** (attempt - 1);
  if (delayMs >= remainingMs(opts, label)) throw new RegistryDeadlineError(label);
  await sleeper(opts)(delayMs);
  remainingMs(opts, label);
}

/**
 * Fetch with bounded retries. The per-request abort timeout is capped to the
 * registry's remaining wall-clock budget, and the deadline is checked before
 * and after every sleep/fetch.
 */
export async function fetchWithRetry<T>(
  url: string,
  opts: RetryOptions = {},
  consume: (response: Response) => Promise<T>,
): Promise<{ response: Response; value: T }> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retries = opts.retries ?? REQUEST_RETRIES;
  const label = opts.label ?? 'registry fetch';
  const fetchImpl = opts.fetchImpl ?? fetch;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await retrySleep(attempt, opts, label);
    const requestTimeout = Math.max(1, Math.min(timeoutMs, remainingMs(opts, label)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    let responseReceived = false;
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      responseReceived = true;
      remainingMs(opts, label);
      // Keep the request timeout active until the response body has been fully
      // consumed. A fetch promise may resolve as soon as headers arrive.
      const value = await consume(response);
      remainingMs(opts, label);
      if (response.status === 429 || response.status >= 500) {
        lastErr = new Error(`HTTP ${response.status}`);
        continue;
      }
      return { response, value };
    } catch (err) {
      if (err instanceof RegistryDeadlineError) throw err;
      if (opts.deadline !== undefined && clock(opts)() >= opts.deadline) {
        throw new RegistryDeadlineError(label);
      }
      // Body/parse failures are retried by fetchJsonPageWithRetry, which keeps
      // malformed-page retry accounting separate from transport retries.
      if (responseReceived) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new RegistryTransportError(label, retries + 1, reason);
}

/**
 * Fetch and parse a complete JSON page. Successful-but-malformed JSON retries
 * the exact same URL. Parsing finishes before the caller can insert anything.
 */
export async function fetchJsonPageWithRetry<T>(
  url: string,
  opts: RetryOptions & { label: string; jsonRetries?: number },
): Promise<{ response: Response; data?: T; errorText?: string }> {
  const jsonRetries = opts.jsonRetries ?? JSON_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= jsonRetries; attempt++) {
    if (attempt > 0) await retrySleep(attempt, opts, opts.label);
    try {
      const { response, value } = await fetchWithRetry(url, opts, async (res) => {
        if (!res.ok) return { errorText: await res.text() };
        return { data: (await res.json()) as T };
      });
      if (!response.ok) {
        return { response, errorText: value.errorText };
      }
      return { response, data: value.data };
    } catch (err) {
      if (err instanceof RegistryDeadlineError || err instanceof RegistryTransportError) throw err;
      lastErr = err;
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `${opts.label}: invalid JSON after ${jsonRetries + 1} attempts — ${reason}`,
  );
}
