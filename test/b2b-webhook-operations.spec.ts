import { describe, expect, it } from 'vitest';

const {
  NO_DELIVERY_REASONS,
  REDELIVERY_OUTCOMES,
  TRANSPORT_STATES,
  publicType,
  redeliveryOutcome,
  transportOf,
} = await import('../dist/b2b-webhooks/webhook-operations.js');

const now = new Date('2026-09-27T12:00:00.000Z');
const event = { occurredAt: new Date('2026-09-27T11:00:00.000Z') };
const endpoint = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  deliverFrom: new Date('2026-09-27T10:00:00.000Z'),
  secretCiphertext: 'v1:a:b:c',
  ...over,
});
const delivery = (over: Record<string, unknown> = {}) => ({
  state: 'PENDING',
  attemptCount: 1,
  nextAttemptAt: new Date('2026-09-27T12:01:00.000Z'),
  lastAttemptAt: new Date('2026-09-27T11:59:00.000Z'),
  deliveredAt: null,
  exhaustedAt: null,
  leaseExpiresAt: null,
  ...over,
});
const read = (d: unknown, e: unknown) =>
  transportOf(event as never, d as never, e as never, now);

/**
 * V1.12-E keeps three things apart: the event is a fact with no state of its own, the transport has
 * one, and the attempts are history. These cases pin the reading an operator is given.
 */
describe('V1.12-E transport state as an operator reads it', () => {
  it('reports the persisted state when the handover is tracked', () => {
    expect(read(delivery(), endpoint())).toMatchObject({
      state: 'PENDING',
      reason: null,
      attemptCount: 1,
      inFlight: false,
    });
    expect(
      read(
        delivery({
          state: 'DELIVERED',
          nextAttemptAt: null,
          deliveredAt: now,
          attemptCount: 2,
        }),
        endpoint(),
      ),
    ).toMatchObject({ state: 'DELIVERED', reason: null, attemptCount: 2 });
    expect(
      read(
        delivery({ state: 'EXHAUSTED', nextAttemptAt: null, exhaustedAt: now }),
        endpoint(),
      ),
    ).toMatchObject({ state: 'EXHAUSTED', reason: null });
  });

  it('says a worker is holding it right now, which is why nothing seems to move', () => {
    expect(
      read(
        delivery({ leaseExpiresAt: new Date('2026-09-27T12:00:30.000Z') }),
        endpoint(),
      ).inFlight,
    ).toBe(true);
    // A lease that already lapsed is not somebody working: it is work waiting to be taken over.
    expect(
      read(
        delivery({ leaseExpiresAt: new Date('2026-09-27T11:59:30.000Z') }),
        endpoint(),
      ).inFlight,
    ).toBe(false);
  });

  it('an untracked event is NO_DELIVERY and says why, and none of the reasons is a fault', () => {
    expect(read(null, null)).toMatchObject({
      state: 'NO_DELIVERY',
      reason: 'NO_ENDPOINT',
      attemptCount: 0,
    });
    // Configured but not signable yet: still nothing to deliver with.
    expect(read(null, endpoint({ secretCiphertext: null })).reason).toBe(
      'NO_ENDPOINT',
    );
    // Older than the boundary: legitimate history, deliberately outside reliable delivery.
    expect(
      read(null, endpoint({ deliverFrom: new Date('2026-09-27T11:30:00.000Z') }))
        .reason,
    ).toBe('BEFORE_BOUNDARY');
    // Eligible, simply not picked up yet. A few seconds, not an incident.
    expect(read(null, endpoint()).reason).toBe('NOT_YET_PICKED_UP');
    for (const r of NO_DELIVERY_REASONS)
      expect(TRANSPORT_STATES).not.toContain(r);
  });

  it('never invents a state that is not in the contract', () => {
    for (const source of [
      [null, null],
      [null, endpoint()],
      [delivery(), endpoint()],
      [delivery({ state: 'DELIVERED', nextAttemptAt: null, deliveredAt: now }), null],
    ] as const)
      expect(TRANSPORT_STATES).toContain(read(source[0], source[1]).state);
  });

  it('the disabled endpoint of a tracked handover does not change its state', () => {
    // Disabling pauses the worker; it does not rewrite what is owed.
    expect(read(delivery(), endpoint({ enabled: false }))).toMatchObject({
      state: 'PENDING',
      reason: null,
    });
  });
});

describe('V1.12-E the vocabulary an operator is shown', () => {
  it('shows the public event name, never the internal enum', () => {
    expect(publicType('DELIVERY_COMPLETED')).toBe('delivery.completed');
  });

  it('a manual request says what happened, not merely that the call returned 200', () => {
    const outcomes = {
      delivered: redeliveryOutcome({
        kind: 'attempted',
        outcomeResult: 'SUCCEEDED',
        state: 'DELIVERED',
      }),
      rescheduled: redeliveryOutcome({
        kind: 'attempted',
        outcomeResult: 'FAILED',
        state: 'PENDING',
      }),
      exhausted: redeliveryOutcome({
        kind: 'attempted',
        outcomeResult: 'FAILED',
        state: 'EXHAUSTED',
      }),
      untracked: redeliveryOutcome({
        kind: 'attempted',
        outcomeResult: 'FAILED',
        state: 'UNTRACKED',
      }),
      skipped: redeliveryOutcome({ kind: 'skipped' }),
    };
    expect(outcomes).toEqual({
      delivered: 'DELIVERED',
      rescheduled: 'RESCHEDULED',
      exhausted: 'EXHAUSTED',
      // Outside reliable delivery there is no next attempt to promise.
      untracked: 'FAILED',
      skipped: 'SKIPPED',
    });
    for (const value of Object.values(outcomes))
      expect(REDELIVERY_OUTCOMES).toContain(value);
  });

  it('a delivered handover is never reported as merely scheduled', () => {
    expect(
      redeliveryOutcome({
        kind: 'attempted',
        outcomeResult: 'SUCCEEDED',
        state: 'UNTRACKED',
      }),
    ).toBe('DELIVERED');
  });
});
