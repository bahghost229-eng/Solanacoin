/**
 * Utilitaire de retry avec backoff exponentiel.
 * Utilisé pour les appels RPC/HTTP qui peuvent échouer transitoirement.
 */
import { logger } from './logger.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  scope?: string;
  onRetry?: (attempt: number, err: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { retries, baseDelayMs = 250, maxDelayMs = 4000, scope = 'retry' } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      logger.debug(scope, `Tentative ${attempt + 1}/${retries} échouée, retry dans ${delay}ms`, {
        error: (err as Error)?.message,
      });
      opts.onRetry?.(attempt + 1, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
