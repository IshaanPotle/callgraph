/**
 * Concurrency + retry primitives.
 *
 * Deliberately hand-written rather than pulling p-limit / p-retry: this is
 * ~60 lines, it is the part of an agent system most likely to need a
 * project-specific tweak (per-agent limits, jitter policy, retry-on-what),
 * and vendoring it keeps the failure modes inspectable.
 */

/** Map with a hard ceiling on in-flight work. Preserves input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast on errors that will never succeed. */
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

/** Exponential backoff with full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.retryable && !opts.retryable(err)) throw err;
      if (attempt === attempts) break;
      opts.onRetry?.(err, attempt);
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      // Full jitter: uniform in [0, ceiling]. Beats equal-jitter under
      // synchronized retry storms, which is exactly what a fan-out of 200
      // extraction calls hitting a rate limit produces.
      await sleep(Math.random() * ceiling);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
