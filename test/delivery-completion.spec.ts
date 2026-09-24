import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  COMPLETION_ERRORS,
  DELIVERY_COMPLETED_EVENT,
  completeDelivery,
  completing,
} from '../dist/deliveries/delivery-completion.js';
import { claimRejection } from '../dist/dispatch/dispatch-policy.js';
import { takeRejection } from '../dist/independent-drivers/independent-driver-policy.js';
import { IndependentDispatchesService } from '../dist/independent-drivers/independent-dispatches.service.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';
import type { B2bWebhooksService } from '../dist/b2b-webhooks/b2b-webhooks.service.js';

const PROVIDER = 'a3f1c0de-0000-4000-8000-000000000001';
const DRIVER = 'a3f1c0de-0000-4000-8000-000000000002';
const USER = 'a3f1c0de-0000-4000-8000-000000000003';
const DISPATCH = 'a3f1c0de-0000-4000-8000-000000000004';
const ASSIGNMENT = 'a3f1c0de-0000-4000-8000-000000000005';
const REQUEST = 'a3f1c0de-0000-4000-8000-000000000006';
const CLIENT = 'a3f1c0de-0000-4000-8000-000000000007';
const EVENT = 'a3f1c0de-0000-4000-8000-000000000008';

const claimed = (extra: object = {}) => ({
  status: 'CLAIMED',
  deliveryRequestId: REQUEST,
  claimedByProviderId: PROVIDER,
  claimedByIndependentDriverId: null,
  deliveredAt: null,
  deliveredByUserId: null,
  ...extra,
});

/**
 * Transaction double: every `FOR UPDATE` raw query answers with the next queued batch of rows, in
 * the order completeDelivery takes its locks (dispatch first, then the active assignment).
 *
 * V1.12-B: the same transaction now also reads the DeliveryRequest and writes the B2B event, so the
 * double knows about both — that third write is part of the completion, not something that happens
 * beside it.
 */
type UpdateCall = { where: { id: string }; data: Record<string, unknown> };
function txDouble(rawRows: unknown[][]) {
  const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
    async () => rawRows.shift() ?? [],
  );
  const assignmentUpdate = vi.fn<(call: UpdateCall) => Promise<{ id: string }>>(
    async () => ({ id: ASSIGNMENT }),
  );
  const dispatchUpdate = vi.fn<(call: UpdateCall) => Promise<{ id: string }>>(
    async () => ({ id: DISPATCH }),
  );
  const eventCreate = vi.fn<(call: unknown) => Promise<{ id: string }>>(
    async () => ({ id: EVENT }),
  );
  const requestRead = vi.fn(async () => ({
    id: REQUEST,
    integrationClientId: CLIENT,
    publicId: 'MDR-000123',
    externalReference: 'ORDER-4711',
    status: 'CREATED',
    requestedAt: new Date('2026-09-24T09:00:00.000Z'),
    cancelledAt: null,
    dispatches: [
      {
        status: 'DELIVERED',
        expiresAt: new Date('2026-09-24T09:10:00.000Z'),
        claimedByProviderId: PROVIDER,
        claimedByIndependentDriverId: null,
        deliveredAt: new Date('2026-09-24T09:47:12.345Z'),
        cancelledAt: null,
      },
    ],
  }));
  const tx = {
    $queryRaw: queryRaw,
    deliveryAssignment: { update: assignmentUpdate },
    dispatch: { update: dispatchUpdate },
    deliveryRequest: { findUniqueOrThrow: requestRead },
    b2bOutboxEvent: { create: eventCreate },
  } as unknown as Prisma.TransactionClient;
  return {
    tx,
    queryRaw,
    assignmentUpdate,
    dispatchUpdate,
    eventCreate,
    requestRead,
  };
}

const code = (error: unknown) =>
  (error as { getResponse(): { code: string } }).getResponse().code;
const status = (error: unknown) =>
  (error as { getStatus(): number }).getStatus();

describe('V1.11-A completion contract', () => {
  it('answers every refusal with 409: a completion is never an internal failure', () => {
    expect(Object.values(COMPLETION_ERRORS)).toEqual([409, 409, 409, 409]);
    expect(Object.keys(COMPLETION_ERRORS)).toEqual([
      'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
      'DISPATCH_NOT_CLAIMED_BY_DRIVER',
      'NO_ACTIVE_ASSIGNMENT',
      'DELIVERY_CONFLICT',
    ]);
  });
  it('names the audit signal of a delivery', () => {
    expect(DELIVERY_COMPLETED_EVENT).toBe('DELIVERY_COMPLETED');
  });
});

describe('V1.11-A provider completion', () => {
  it('ends the assignment as COMPLETED and resolves the dispatch as DELIVERED, atomically', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    const before = Date.now();
    const outcome = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    expect(outcome).toMatchObject({
      kind: 'completed',
      assignmentId: ASSIGNMENT,
    });
    const deliveredAt = (outcome as { deliveredAt: Date }).deliveredAt;
    // The timestamp is the server's, not the client's, and both writes share it exactly.
    expect(deliveredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(t.assignmentUpdate).toHaveBeenCalledWith({
      where: { id: ASSIGNMENT },
      data: {
        status: 'COMPLETED',
        endedAt: deliveredAt,
        endedByUserId: USER,
      },
    });
    expect(t.dispatchUpdate).toHaveBeenCalledWith({
      where: { id: DISPATCH },
      data: {
        status: 'DELIVERED',
        deliveredAt,
        deliveredByUserId: USER,
      },
    });
  });
  it('closes the assignment without a motive: nothing failed', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    const data = t.assignmentUpdate.mock.calls[0][0].data;
    expect('endReason' in data).toBe(false);
    expect('endReasonDetail' in data).toBe(false);
  });
  it('writes the assignment before the dispatch, the only order SQL accepts', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    expect(t.assignmentUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      t.dispatchUpdate.mock.invocationCallOrder[0],
    );
  });
  it('locks the dispatch row and the active assignment row', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    const sql = t.queryRaw.mock.calls.map((c) =>
      (c[0] as unknown as { join(s: string): string }).join('?'),
    );
    expect(sql[0]).toMatch(/FROM "Dispatch".*FOR UPDATE OF d/s);
    expect(sql[1]).toMatch(
      /FROM "DeliveryAssignment".*status = 'ACTIVE'.*FOR UPDATE/s,
    );
  });
  it('refuses a dispatch claimed by another provider without writing anything', async () => {
    const t = txDouble([[claimed({ claimedByProviderId: 'someone-else' })]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect(status(error)).toBe(409);
    expect(t.assignmentUpdate).not.toHaveBeenCalled();
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
  });
  it('refuses a cancelled dispatch even though its claim owner is still recorded', async () => {
    const t = txDouble([[claimed({ status: 'CANCELLED' })]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
  });
  it('refuses a claim with no driver and vehicle: there is nothing to deliver', async () => {
    const t = txDouble([[claimed()], []]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('NO_ACTIVE_ASSIGNMENT');
    expect(status(error)).toBe(409);
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
  });
  it('reports an unknown dispatch as 404, never as a completion error', async () => {
    const t = txDouble([[]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    ).catch((e: unknown) => e);
    expect(status(error)).toBe(404);
  });
  it('repeats the same answer for the owner without writing again', async () => {
    const deliveredAt = new Date('2026-09-23T10:00:00Z');
    const t = txDouble([
      [claimed({ status: 'DELIVERED', deliveredAt, deliveredByUserId: USER })],
    ]);
    const outcome = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    expect(outcome).toEqual({
      kind: 'already',
      deliveredAt,
      deliveredByUserId: USER,
    });
    expect(t.assignmentUpdate).not.toHaveBeenCalled();
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
    // V1.12-B: and no second event either. Repeating a delivery cannot announce it twice.
    expect(t.eventCreate).not.toHaveBeenCalled();
  });

  it('records the B2B event in the same transaction, on the delivery own clock', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    const outcome = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    );
    expect(t.eventCreate).toHaveBeenCalledTimes(1);
    const call = t.eventCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    const stamped = (
      t.dispatchUpdate.mock.calls[0][0].data as { deliveredAt: Date }
    ).deliveredAt;
    expect(call.data).toMatchObject({
      type: 'DELIVERY_COMPLETED',
      integrationClientId: CLIENT,
      deliveryRequestId: REQUEST,
      dispatchId: DISPATCH,
      occurredAt: stamped,
    });
    // The same Date the dispatch was stamped with: one clock, read once.
    expect(outcome).toMatchObject({ kind: 'completed', deliveredAt: stamped });
  });
});

describe('V1.11-A independent completion', () => {
  const taken = (extra: object = {}) =>
    claimed({
      claimedByProviderId: null,
      claimedByIndependentDriverId: DRIVER,
      ...extra,
    });
  it('closes the driver assignment and delivers the dispatch', async () => {
    const t = txDouble([[taken()], [{ id: ASSIGNMENT }]]);
    const outcome = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'INDEPENDENT', driverId: DRIVER },
      USER,
    );
    expect(outcome).toMatchObject({
      kind: 'completed',
      assignmentId: ASSIGNMENT,
    });
    expect(t.assignmentUpdate.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      endedByUserId: USER,
    });
  });
  it('refuses a service taken by another driver with the driver-facing code', async () => {
    const t = txDouble([[taken({ claimedByIndependentDriverId: 'other' })]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'INDEPENDENT', driverId: DRIVER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DISPATCH_NOT_CLAIMED_BY_DRIVER');
    expect(status(error)).toBe(409);
  });
  it('never lets a provider complete a service an independent driver took', async () => {
    const t = txDouble([[taken()]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'FLEET', providerId: PROVIDER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
  });
  it('never lets a driver complete a service a provider claimed', async () => {
    const t = txDouble([[claimed()]]);
    const error = await completeDelivery(
      t.tx,
      DISPATCH,
      { mode: 'INDEPENDENT', driverId: DRIVER },
      USER,
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DISPATCH_NOT_CLAIMED_BY_DRIVER');
    expect(t.dispatchUpdate).not.toHaveBeenCalled();
  });
});

describe('V1.11-A completion writes nothing economic', () => {
  it('touches only the assignment and the dispatch', async () => {
    const t = txDouble([[claimed()], [{ id: ASSIGNMENT }]]);
    // The double exposes no credit model at all: any ledger, account or snapshot write would
    // throw here instead of passing silently.
    await expect(
      completeDelivery(
        t.tx,
        DISPATCH,
        { mode: 'FLEET', providerId: PROVIDER },
        USER,
      ),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(t.assignmentUpdate).toHaveBeenCalledTimes(1);
    expect(t.dispatchUpdate).toHaveBeenCalledTimes(1);
    expect(t.queryRaw).toHaveBeenCalledTimes(2);
    // V1.12-B adds exactly one more write, and it is the event: still nothing economic.
    expect(t.eventCreate).toHaveBeenCalledTimes(1);
  });
});

describe('V1.11-A guard rejections', () => {
  it('turns a PostgreSQL guard into a 409, never a 500', async () => {
    const error = await completing(
      Promise.reject(
        new Error('raw query failed: P0001 DISPATCH_IMMUTABLE: ...'),
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('DELIVERY_CONFLICT');
    expect(status(error)).toBe(409);
  });
  it('keeps a decided refusal with its own code', async () => {
    const t = txDouble([[claimed()], []]);
    const error = await completing(
      completeDelivery(
        t.tx,
        DISPATCH,
        { mode: 'FLEET', providerId: PROVIDER },
        USER,
      ),
    ).catch((e: unknown) => e);
    expect(code(error)).toBe('NO_ACTIVE_ASSIGNMENT');
  });
  it('lets an unrelated failure through untouched', async () => {
    const boom = new Error('connection reset');
    await expect(completing(Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('V1.11-A DELIVERED is terminal for both execution models', () => {
  const window = new Date('2026-09-23T12:00:00Z');
  const now = new Date('2026-09-23T11:00:00Z');
  it('stops a provider from claiming a delivered service, including the one that delivered it', () => {
    const dispatch = {
      status: 'DELIVERED' as const,
      expiresAt: window,
      claimedByProviderId: PROVIDER,
    };
    expect(
      claimRejection(dispatch, { status: 'OFFERED' }, 'another', now),
    ).toBe('DISPATCH_DELIVERED');
    // Not ALREADY_OWNER: repeating a claim is only meaningful while the service is still CLAIMED.
    expect(claimRejection(dispatch, { status: 'CLAIMED' }, PROVIDER, now)).toBe(
      'DISPATCH_DELIVERED',
    );
  });
  it('stops an independent driver from taking a delivered service', () => {
    expect(
      takeRejection(
        {
          status: 'DELIVERED',
          expiresAt: window,
          serviceType: 'LOCAL_DELIVERY',
        },
        false,
        now,
      ),
    ).toBe('DISPATCH_DELIVERED');
  });
});

describe('V1.11-A the independent completion does not re-run the approval gate', () => {
  it('closes the service without ever reading the independent profile', async () => {
    const dispatchUpdate = vi.fn(async () => ({ id: DISPATCH }));
    const rows: unknown[][] = [
      [
        {
          status: 'CLAIMED',
          deliveryRequestId: REQUEST,
          claimedByProviderId: null,
          claimedByIndependentDriverId: DRIVER,
          deliveredAt: null,
          deliveredByUserId: null,
        },
      ],
      [{ id: ASSIGNMENT }],
    ];
    const client = {
      $queryRaw: vi.fn(async () => rows.shift() ?? []),
      driver: { findUnique: vi.fn(async () => ({ id: DRIVER })) },
      deliveryAssignment: { update: vi.fn(async () => ({ id: ASSIGNMENT })) },
      deliveryRequest: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: REQUEST,
          integrationClientId: CLIENT,
          publicId: 'MDR-000123',
          externalReference: null,
          status: 'CREATED',
          requestedAt: new Date('2026-09-24T09:00:00.000Z'),
          cancelledAt: null,
          dispatches: [
            {
              status: 'DELIVERED',
              expiresAt: new Date('2026-09-24T09:10:00.000Z'),
              claimedByProviderId: null,
              claimedByIndependentDriverId: DRIVER,
              deliveredAt: new Date('2026-09-24T09:47:12.345Z'),
              cancelledAt: null,
            },
          ],
        })),
      },
      b2bOutboxEvent: { create: vi.fn(async () => ({ id: EVENT })) },
      dispatch: {
        update: dispatchUpdate,
        // viewFor runs after the transaction has committed; returning nothing only affects the
        // rendering of the response, which is not what this case is about.
        findFirst: vi.fn(async () => null),
      },
      independentDriverProfile: {
        findUnique: vi.fn(() => {
          throw new Error('the approval gate must not run at completion time');
        }),
      },
    };
    const prisma = {
      ...client,
      $transaction: (fn: (t: typeof client) => unknown) => fn(client),
    } as unknown as PrismaService;
    const service = new IndependentDispatchesService(prisma, {
      scheduleFirstAttempt: () => undefined,
    } as unknown as B2bWebhooksService);
    // A suspension landing mid-service must never strand a finished delivery, so the only thing
    // checked is that this driver holds the claim.
    await expect(service.complete(USER, DISPATCH)).rejects.toMatchObject({
      status: 404,
    });
    expect(dispatchUpdate).toHaveBeenCalledWith({
      where: { id: DISPATCH },
      data: expect.objectContaining({
        status: 'DELIVERED',
        deliveredByUserId: USER,
      }),
    });
    expect(client.independentDriverProfile.findUnique).not.toHaveBeenCalled();
  });
});
