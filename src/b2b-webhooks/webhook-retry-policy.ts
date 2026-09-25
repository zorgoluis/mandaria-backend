/**
 * V1.12-D: when to try again, and when to stop.
 *
 * The schedule lives in code, in one place, rather than in five environment variables. An operator
 * tuning a backoff curve variable by variable is how curves become incoherent; if this ever needs
 * to differ per client it should become a deliberate, versioned policy like the credit ones, not a
 * scattering of settings.
 */

/** Delay before attempt N+1, in milliseconds. The first attempt is immediate. */
const BACKOFF_MS = [
  60_000, // after attempt 1: 1 minute
  5 * 60_000, // after attempt 2: 5 minutes
  15 * 60_000, // after attempt 3: 15 minutes
  60 * 60_000, // after attempt 4: 1 hour
] as const;

/** Five attempts in total, spread over roughly 81 minutes. */
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export const backoffMs = (attemptsMade: number) =>
  BACKOFF_MS[attemptsMade - 1] ?? null;

/**
 * How Mandaria reads an answer. Anything that could plausibly succeed later is retried; anything
 * that says "this request is wrong" or "I already have it" is not, because repeating it would only
 * hammer a receiver that is behaving correctly.
 *
 * 409 is treated as **terminal**, and the decision is deliberate rather than inherited: the
 * deduplication contract tells consumers to reject an `eventId` they already processed, and a
 * conflict is the natural way to say so. Retrying would punish exactly the receivers that followed
 * the contract. A receiver that means "busy, come back later" has 429 and 503 for that.
 */
export type HttpDisposition = 'SUCCESS' | 'RETRYABLE' | 'TERMINAL';

const RETRYABLE_STATUS = new Set([408, 425, 429]);
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 422, 451]);

export function classifyStatus(status: number): HttpDisposition {
  if (status >= 200 && status <= 299) return 'SUCCESS';
  if (RETRYABLE_STATUS.has(status)) return 'RETRYABLE';
  if (status >= 500 && status <= 599) return 'RETRYABLE';
  if (TERMINAL_STATUS.has(status)) return 'TERMINAL';
  // Anything unclassified in 4xx is a client-side problem: retrying will not change it. A 3xx is
  // a redirect Mandaria refuses to follow, and repeating it would not help either.
  return 'TERMINAL';
}

/** A failure that never reached a status code. */
export const classifyFailure = (
  kind: 'TIMEOUT' | 'NETWORK' | 'INVALID_ENDPOINT',
): HttpDisposition =>
  // A destination that stopped being acceptable is not something to hammer: it needs a human to
  // change the configuration, or DNS to go back to pointing somewhere legitimate. Timeouts and
  // network errors are the ordinary transient failures retries exist for.
  kind === 'INVALID_ENDPOINT' ? 'TERMINAL' : 'RETRYABLE';

export type NextStep =
  | { state: 'DELIVERED' }
  | { state: 'PENDING'; nextAttemptAt: Date }
  | { state: 'EXHAUSTED' };

/**
 * What to do after an attempt: deliver, schedule the next one, or stop. Pure, so the whole curve
 * can be asserted without waiting an hour for it.
 */
export function nextStep(
  disposition: HttpDisposition,
  attemptsMade: number,
  now: Date,
): NextStep {
  if (disposition === 'SUCCESS') return { state: 'DELIVERED' };
  if (disposition === 'TERMINAL') return { state: 'EXHAUSTED' };
  const delay = attemptsMade >= MAX_ATTEMPTS ? null : backoffMs(attemptsMade);
  return delay === null
    ? { state: 'EXHAUSTED' }
    : { state: 'PENDING', nextAttemptAt: new Date(now.getTime() + delay) };
}
