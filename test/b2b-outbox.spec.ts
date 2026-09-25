import { describe, expect, it } from 'vitest';

const { B2B_EVENT_TYPES, b2bEventPayload, recordedEventLog } = await import(
  '../dist/b2b-events/b2b-outbox.js'
);
const { deliveryStatusView } = await import(
  '../dist/deliveries/delivery-status.js'
);

/**
 * V1.12-B: the event is built from the V1.12-A public model and nothing else. These cases pin the
 * envelope, the snapshot and, above all, the fact that there is a single canonical mapping: the
 * payload is what `deliveryStatusView` says, serialized — never a dump of Prisma rows.
 */
const requestedAt = new Date('2026-09-24T09:00:00.000Z');
const deliveredAt = new Date('2026-09-24T09:47:12.345Z');

const delivered = (over: Record<string, unknown> = {}) => ({
  publicId: 'MDR-000123',
  externalReference: 'ORDER-4711',
  status: 'CREATED',
  requestedAt,
  cancelledAt: null,
  dispatches: [
    {
      status: 'DELIVERED',
      expiresAt: new Date('2026-09-24T09:10:00.000Z'),
      claimedByProviderId: 'provider-1',
      claimedByIndependentDriverId: null,
      deliveredAt,
      cancelledAt: null,
      ...over,
    },
  ],
});
const payloadOf = (row: object) =>
  b2bEventPayload(deliveryStatusView(row as never, deliveredAt));

describe('V1.12-B delivery.completed event', () => {
  it('names the event delivery.completed on the wire', () => {
    expect(B2B_EVENT_TYPES.DELIVERY_COMPLETED).toBe('delivery.completed');
  });

  it('carries the public contract of V1.12-A, serialized as JSON renders it', () => {
    expect(payloadOf(delivered())).toEqual({
      publicId: 'MDR-000123',
      externalReference: 'ORDER-4711',
      status: 'DELIVERED',
      execution: { mode: 'PROVIDER' },
      requestedAt: '2026-09-24T09:00:00.000Z',
      deliveredAt: '2026-09-24T09:47:12.345Z',
      cancelledAt: null,
    });
  });

  it('is the same payload for an independent delivery except for the execution mode', () => {
    const independent = payloadOf(
      delivered({
        claimedByProviderId: null,
        claimedByIndependentDriverId: 'driver-1',
      }),
    );
    expect(independent.execution).toEqual({ mode: 'INDEPENDENT' });
    expect({ ...independent, execution: null }).toEqual({
      ...payloadOf(delivered()),
      execution: null,
    });
  });

  it('keeps externalReference exactly as the client sent it, including when absent', () => {
    const opaque = 'órden/#4711 — "COITA"  ';
    expect(
      payloadOf({ ...delivered(), externalReference: opaque }),
    ).toMatchObject({ externalReference: opaque });
    expect(
      payloadOf({ ...delivered(), externalReference: null }),
    ).toMatchObject({ externalReference: null });
  });

  it('exposes exactly the seven public keys, and never an internal identifier', () => {
    const payload = payloadOf(delivered());
    expect(Object.keys(payload).sort()).toEqual([
      'cancelledAt',
      'deliveredAt',
      'execution',
      'externalReference',
      'publicId',
      'requestedAt',
      'status',
    ]);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      'provider-1',
      'driver-1',
      'dispatchId',
      'deliveryRequestId',
      'integrationClientId',
      'deliveredByUserId',
      'driverId',
      'vehicleId',
      'providerId',
      'claimedBy',
      'credit',
      'ledger',
      'goodsValue',
      'expiresAt',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('says DELIVERED and carries the delivery timestamp, which is the event clock', () => {
    const payload = payloadOf(delivered());
    expect(payload.status).toBe('DELIVERED');
    expect(payload.deliveredAt).toBe(deliveredAt.toISOString());
    expect(payload.cancelledAt).toBeNull();
  });

  it('keeps the delivery in the snapshot even if the request is cancelled afterwards', () => {
    // The dispatch decides, exactly as V1.12-A decided: a completed delivery stays completed.
    const payload = payloadOf({
      ...delivered(),
      status: 'CANCELLED',
      cancelledAt: new Date('2026-09-24T10:00:00.000Z'),
    });
    expect(payload).toMatchObject({ status: 'DELIVERED', cancelledAt: null });
  });

  it('logs the event without its payload: ids, type and time only', () => {
    const log = recordedEventLog({
      eventId: '0f1f2b60-6a4e-4a2e-9a2a-6a7d8f9c1234',
      type: B2B_EVENT_TYPES.DELIVERY_COMPLETED,
      occurredAt: deliveredAt,
      data: deliveryStatusView(delivered() as never, deliveredAt),
    } as never);
    expect(log).toEqual({
      event: 'B2B_EVENT_RECORDED',
      eventId: '0f1f2b60-6a4e-4a2e-9a2a-6a7d8f9c1234',
      type: 'delivery.completed',
      publicId: 'MDR-000123',
      occurredAt: '2026-09-24T09:47:12.345Z',
    });
    // The client's own reference is not application-log material.
    expect(JSON.stringify(log)).not.toContain('ORDER-4711');
  });

  it('the event id is its own identity, never the delivery public id', () => {
    const log = recordedEventLog({
      eventId: '0f1f2b60-6a4e-4a2e-9a2a-6a7d8f9c1234',
      type: B2B_EVENT_TYPES.DELIVERY_COMPLETED,
      occurredAt: deliveredAt,
      data: deliveryStatusView(delivered() as never, deliveredAt),
    } as never);
    expect(log.eventId).not.toBe(log.publicId);
  });
});
