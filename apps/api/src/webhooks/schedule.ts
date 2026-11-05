/** A delivery is tried at most this many times. */
export const MAX_ATTEMPTS = 15;

const BASE_SECONDS = 10;
const CAP_SECONDS = 6 * 3600;

/**
 * Seconds to wait before the next try, after `attempt` tries have failed (1-based): 10 s doubling to a 6 hour cap,
 * each spread 75% to 125% by jitter so retries from many deliveries do not arrive together. Returns null once
 * the delivery has used all its attempts. `random` returns a number from 0 to 1.
 */
export function nextAttemptDelaySeconds(attempt: number, random: () => number = Math.random): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  if (attempt >= MAX_ATTEMPTS) return null;
  const base = Math.min(BASE_SECONDS * 2 ** (attempt - 1), CAP_SECONDS);
  return Math.min(Math.round(base * (0.75 + 0.5 * random())), CAP_SECONDS);
}
