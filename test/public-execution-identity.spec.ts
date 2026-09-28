import { describe, expect, it } from 'vitest';
const { deliveryStatusView } =
  await import('../dist/deliveries/delivery-status.js');
const { b2bEventPayload } = await import('../dist/b2b-events/b2b-outbox.js');
const { webhookBody } =
  await import('../dist/b2b-webhooks/webhook-transport.js');
const at = new Date('2026-09-28T10:00:00Z');
const view = (changes: object = {}) =>
  deliveryStatusView(
    {
      publicId: 'MDR-000001',
      externalReference: null,
      status: 'CREATED',
      requestedAt: at,
      cancelledAt: null,
      dispatches: [
        {
          status: 'CLAIMED',
          expiresAt: new Date('2026-09-28T11:00:00Z'),
          claimedByProviderId: 'private-provider',
          claimedByIndependentDriverId: null,
          deliveredAt: null,
          cancelledAt: null,
          publicExecutionSnapshot: null,
          candidates: [
            {
              providerId: 'private-provider',
              provider: { name: 'Marca pública', taxId: 'private-tax' },
            },
          ],
          deliveryAssignments: [
            {
              driver: {
                displayName: null,
                name: 'Private legal name',
                email: 'private@example.test',
              },
            },
          ],
          ...changes,
        },
      ],
    } as never,
    at,
  );

describe('V1.12-G public execution contract', () => {
  it('uses only explicit displayName and never operational/private fallback', () => {
    expect(view().execution).toEqual({
      mode: 'PROVIDER',
      provider: { displayName: 'Marca pública' },
      driver: null,
    });
    const publicView = view({
      deliveryAssignments: [
        {
          driver: {
            displayName: 'Alex',
            id: 'private-driver',
            name: 'Private legal name',
          },
        },
      ],
    });
    expect(publicView.execution?.driver).toEqual({ displayName: 'Alex' });
    expect(JSON.stringify(publicView)).not.toMatch(/private|Private/);
  });
  it('keeps mode for historical delivered services without inventing identities from current profiles', () => {
    const result = view({
      status: 'DELIVERED',
      deliveredAt: at,
      deliveryAssignments: [{ driver: { displayName: 'New person' } }],
    });
    expect(result.execution).toEqual({
      mode: 'PROVIDER',
      provider: null,
      driver: null,
    });
  });
  it('reads the frozen completed identity and allowlists all nested fields', () => {
    const frozen = {
      mode: 'PROVIDER',
      provider: { displayName: 'Old brand', phone: 'private-phone' },
      driver: { displayName: 'Old person', userId: 'private-user' },
    };
    const result = view({
      status: 'DELIVERED',
      deliveredAt: at,
      publicExecutionSnapshot: frozen,
    });
    expect(result.execution).toEqual({
      mode: 'PROVIDER',
      provider: { displayName: 'Old brand' },
      driver: { displayName: 'Old person' },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('Independent execution never publishes the driver parent provider', () => {
    expect(
      view({
        claimedByProviderId: null,
        claimedByIndependentDriverId: 'private-driver',
        deliveryAssignments: [{ driver: { displayName: 'Alex' } }],
      }).execution,
    ).toEqual({
      mode: 'INDEPENDENT',
      provider: null,
      driver: { displayName: 'Alex' },
    });
  });
  it('OPEN and released services never expose a previous executor or candidates', () => {
    expect(
      view({ status: 'OPEN', claimedByProviderId: null }).execution,
    ).toBeNull();
    expect(view({ status: 'OPEN' }).execution).toBeNull();
  });
  it('the durable payload and retry envelope preserve public identity with the old mode field', () => {
    const result = view({
      status: 'DELIVERED',
      deliveredAt: at,
      publicExecutionSnapshot: {
        mode: 'PROVIDER',
        provider: { displayName: 'Brand' },
        driver: { displayName: 'Alex' },
      },
    });
    const payload = b2bEventPayload(result);
    const event = {
      id: 'event',
      type: 'DELIVERY_COMPLETED' as const,
      occurredAt: at,
      payload,
    };
    expect(webhookBody(event).data).toEqual(JSON.parse(JSON.stringify(result)));
    expect((webhookBody(event).data as typeof payload).execution?.mode).toBe(
      'PROVIDER',
    );
  });
});
