import { describe, expect, it } from 'vitest';

const { deliveryStatusView, B2B_DELIVERY_STATUSES } =
  await import('../dist/deliveries/delivery-status.js');

/**
 * V1.12-A: the public status is a translation of the real internal state, and every internal state
 * the domain can reach must land on one of the public ones. No internal state may produce
 * undefined, UNKNOWN or a crash.
 */
const openedAt = new Date('2026-09-23T10:00:00.000Z');
const expiresAt = new Date('2026-09-23T10:10:00.000Z');
const inWindow = new Date('2026-09-23T10:05:00.000Z');
const afterWindow = new Date('2026-09-23T11:00:00.000Z');

const request = (over: Record<string, unknown> = {}) => ({
  publicId: 'MDR-000123',
  externalReference: 'ORDER-4711',
  status: 'CREATED',
  requestedAt: openedAt,
  cancelledAt: null,
  dispatches: [],
  ...over,
});
const dispatch = (over: Record<string, unknown> = {}) => ({
  status: 'OPEN',
  expiresAt,
  claimedByProviderId: null,
  claimedByIndependentDriverId: null,
  deliveredAt: null,
  cancelledAt: null,
  ...over,
});
const view = (row: object, now = inWindow) =>
  deliveryStatusView(row as never, now);

describe('V1.12-A public delivery status', () => {
  it('a request without a dispatch is REQUESTED, with no execution and no timestamps', () => {
    expect(view(request())).toEqual({
      publicId: 'MDR-000123',
      externalReference: 'ORDER-4711',
      status: 'REQUESTED',
      execution: null,
      requestedAt: openedAt,
      deliveredAt: null,
      cancelledAt: null,
    });
  });

  it('a request cancelled before any service was published is CANCELLED', () => {
    const cancelledAt = new Date('2026-09-23T10:02:00.000Z');
    expect(view(request({ status: 'CANCELLED', cancelledAt }))).toMatchObject({
      status: 'CANCELLED',
      cancelledAt,
      execution: null,
    });
  });

  it('a published dispatch with no candidates is still OPEN', () => {
    // V1.9: a dispatch can be OPEN with zero candidates; that is not an error for a B2B client.
    expect(view(request({ dispatches: [dispatch()] }))).toMatchObject({
      status: 'OPEN',
      execution: null,
      deliveredAt: null,
    });
  });

  it('a provider claim reads as ASSIGNED with PROVIDER execution', () => {
    expect(
      view(
        request({
          dispatches: [
            dispatch({ status: 'CLAIMED', claimedByProviderId: 'provider-1' }),
          ],
        }),
      ),
    ).toMatchObject({
      status: 'ASSIGNED',
      execution: { mode: 'PROVIDER' },
      deliveredAt: null,
    });
  });

  it('an independent take reads as ASSIGNED with INDEPENDENT execution', () => {
    expect(
      view(
        request({
          dispatches: [
            dispatch({
              status: 'CLAIMED',
              claimedByIndependentDriverId: 'driver-1',
            }),
          ],
        }),
      ),
    ).toMatchObject({ status: 'ASSIGNED', execution: { mode: 'INDEPENDENT' } });
  });

  it('a driver and vehicle assignment does not change the public status: it is still ASSIGNED', () => {
    // The public contract says "somebody is executing it"; who drives is internal.
    const claimed = request({
      dispatches: [
        dispatch({ status: 'CLAIMED', claimedByProviderId: 'provider-1' }),
      ],
    });
    expect(view(claimed).status).toBe('ASSIGNED');
  });

  it('a delivered dispatch reads as DELIVERED with its timestamp and execution mode', () => {
    const deliveredAt = new Date('2026-09-23T10:40:00.000Z');
    expect(
      view(
        request({
          dispatches: [
            dispatch({
              status: 'DELIVERED',
              claimedByProviderId: 'provider-1',
              deliveredAt,
            }),
          ],
        }),
      ),
    ).toMatchObject({
      status: 'DELIVERED',
      deliveredAt,
      execution: { mode: 'PROVIDER' },
      cancelledAt: null,
    });
  });

  it('an independent delivery is publicly identical except for the execution mode', () => {
    const deliveredAt = new Date('2026-09-23T10:40:00.000Z');
    const independent = view(
      request({
        dispatches: [
          dispatch({
            status: 'DELIVERED',
            claimedByIndependentDriverId: 'driver-1',
            deliveredAt,
          }),
        ],
      }),
    );
    expect(independent).toMatchObject({
      status: 'DELIVERED',
      deliveredAt,
      execution: { mode: 'INDEPENDENT' },
    });
  });

  it('a cancelled dispatch reads as CANCELLED and keeps the cancellation time', () => {
    const cancelledAt = new Date('2026-09-23T10:06:00.000Z');
    expect(
      view(
        request({
          status: 'CANCELLED',
          cancelledAt,
          dispatches: [
            dispatch({
              status: 'CANCELLED',
              claimedByProviderId: 'provider-1',
              cancelledAt,
            }),
          ],
        }),
      ),
    ).toMatchObject({ status: 'CANCELLED', cancelledAt, deliveredAt: null });
  });

  it('an expired dispatch reads as EXPIRED, distinct from a cancellation', () => {
    expect(
      view(request({ dispatches: [dispatch({ status: 'EXPIRED' })] })),
    ).toMatchObject({ status: 'EXPIRED', cancelledAt: null });
  });

  it('an OPEN dispatch past its window reads as EXPIRED, like everywhere else in the domain', () => {
    // V1.7 expiry is lazy: the row still says OPEN until something writes it.
    expect(
      view(request({ dispatches: [dispatch()] }), afterWindow).status,
    ).toBe('EXPIRED');
    expect(view(request({ dispatches: [dispatch()] }), inWindow).status).toBe(
      'OPEN',
    );
  });

  it('a delivery already completed stays DELIVERED even if the request is cancelled afterwards', () => {
    const deliveredAt = new Date('2026-09-23T10:40:00.000Z');
    expect(
      view(
        request({
          status: 'CANCELLED',
          cancelledAt: new Date('2026-09-23T10:50:00.000Z'),
          dispatches: [
            dispatch({
              status: 'DELIVERED',
              claimedByProviderId: 'provider-1',
              deliveredAt,
            }),
          ],
        }),
      ),
    ).toMatchObject({ status: 'DELIVERED', deliveredAt, cancelledAt: null });
  });

  it('every internal dispatch state maps to a public one: no UNKNOWN, no undefined', () => {
    const internal = ['OPEN', 'CLAIMED', 'EXPIRED', 'CANCELLED', 'DELIVERED'];
    const mapped = internal.map(
      (status) => view(request({ dispatches: [dispatch({ status })] })).status,
    );
    expect(mapped).toEqual([
      'OPEN',
      'ASSIGNED',
      'EXPIRED',
      'CANCELLED',
      'DELIVERED',
    ]);
    for (const status of mapped)
      expect(B2B_DELIVERY_STATUSES).toContain(status);
    // And the request-level states are covered too.
    expect([
      view(request()).status,
      view(request({ status: 'CANCELLED' })).status,
    ]).toEqual(['REQUESTED', 'CANCELLED']);
  });

  it('exposes only the public contract: no internal ids, no credits, no payment context', () => {
    const keys = Object.keys(
      view(
        request({
          dispatches: [
            dispatch({
              status: 'DELIVERED',
              claimedByProviderId: 'provider-1',
              deliveredAt: new Date(),
            }),
          ],
        }),
      ),
    ).sort();
    expect(keys).toEqual([
      'cancelledAt',
      'deliveredAt',
      'execution',
      'externalReference',
      'publicId',
      'requestedAt',
      'status',
    ]);
  });
});
