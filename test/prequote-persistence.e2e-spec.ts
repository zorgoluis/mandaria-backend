import { ownerFields } from '../dist/customers/demand-owner.js';
import 'reflect-metadata';
import { randomUUID, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrequotePersistenceService,
  type PrequoteLease,
  PREQUOTE_OPERATION,
} from '../src/delivery-prequotes/prequote-persistence.service.js';
import {
  normalizePrequoteConditions,
  prequoteEffectiveStatus,
} from '../src/delivery-prequotes/prequote-conditions.js';
import { IdempotencyService } from '../src/idempotency/idempotency.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ServiceZonesService } from '../src/service-zones/service-zones.service.js';
import { RatePlansService } from '../src/rate-plans/rate-plans.service.js';
import { nextPublicId } from '../src/common/public-id.js';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith('_test')
)
  throw Error('Local test database required');
const p = new PrismaClient({ datasourceUrl: url });
const db = p as unknown as PrismaService;
const zones = new ServiceZonesService(db);
const plans = new RatePlansService(db);
const service = new PrequotePersistenceService(db, zones, plans);
const legacy = new IdempotencyService(db);
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const clients = [randomUUID(), randomUUID()];
let zoneId: string;
let planId: string;
let bandId: string;
const latitude = 50 + randomInt(0, 100000) / 10000;
const n = (offset: number) => Number((latitude + offset).toFixed(6));
const conditions = {
  conditionsVersion: 1,
  serviceType: 'LOCAL_DELIVERY',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      latitude: n(0.000002),
      longitude: 70.000002,
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      latitude: n(0.000008),
      longitude: 70.000008,
    },
  ],
  packages: [{ category: 'FOOD', quantity: 1 }],
};
const policy = { leaseMs: 60_000, maxAttempts: 3 };
const key = () => `a3-${randomUUID()}`;
const evidence = () => ({
  serviceZoneId: zoneId,
  ratePlanId: planId,
  route: {
    distanceMeters: 1200,
    durationSeconds: 60,
    routingProvider: 'a3-simulated',
    calculatedAt: new Date(),
  },
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function acquired(k = key(), options = policy, client = clients[0]) {
  const r = await service.reserve(client, k, conditions, options);
  expect(r.kind).toBe('acquired');
  if (r.kind !== 'acquired') throw Error('not acquired');
  return { ...r, key: k };
}
async function operationalCounts() {
  return Promise.all([
    p.deliveryRequest.count(),
    p.deliveryQuote.count(),
    p.dispatch.count(),
    p.creditLedgerEntry.count(),
  ]);
}
let baseline: number[];
beforeAll(async () => {
  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `A3_${run}_${i}`,
      name: 'A3 fixture',
    })),
  });
  const zone = await p.serviceZone.create({
    data: {
      code: `A3_${run}`,
      name: 'A3 zone',
      status: 'ACTIVE',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [70, latitude],
            [70.00001, latitude],
            [70.00001, n(0.00001)],
            [70, n(0.00001)],
            [70, latitude],
          ],
        ],
      },
      minLatitude: latitude,
      maxLatitude: n(0.00001),
      minLongitude: 70,
      maxLongitude: 70.00001,
    },
  });
  zoneId = zone.id;
  const plan = await p.ratePlan.create({
    data: {
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      status: 'DRAFT',
      quoteValidityMinutes: 15,
      currency: 'MXN',
      bands: {
        create: {
          minDistanceMeters: 0,
          maxDistanceMeters: 10000,
          amount: '25.10',
          currency: 'MXN',
        },
      },
    },
    include: { bands: true },
  });
  planId = plan.id;
  bandId = plan.bands[0].id;
  await p.ratePlan.update({
    where: { id: planId },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  baseline = await operationalCounts();
});
afterAll(async () => {
  if (zoneId)
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  await p.$disconnect();
});

describe.sequential('A3 internal protocol with real PostgreSQL', () => {
  it('reserves once concurrently, performs simulated work without holding locks, publishes and replays after lost response', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.reserve(clients[0], k, conditions, policy),
      ),
    );
    expect(results.filter((r) => r.kind === 'acquired')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'in_progress')).toHaveLength(7);
    const winner = results.find((r) => r.kind === 'acquired')!;
    if (winner.kind !== 'acquired') throw Error();
    // Independent transaction can NOWAIT-lock the key while simulated work is running.
    await p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ApiIdempotencyRecord" WHERE id=${winner.lease.recordId}::uuid FOR UPDATE NOWAIT`;
    });
    const q = await service.publish(
      winner.lease,
      conditions,
      evidence(),
      900_000,
    );
    expect(q.publicId).toMatch(/^MPQ-\d{6,}$/);
    expect(q.amount.toFixed(2)).toBe('25.10');
    expect(q.currency).toBe('MXN');
    expect(q.expiresAt.getTime() - q.issuedAt.getTime()).toBe(900000);
    expect(prequoteEffectiveStatus(q, q.expiresAt)).toBe('EXPIRED');
    const replays = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.reserve(clients[0], k, conditions, policy),
      ),
    );
    for (const r of replays) {
      expect(r.kind).toBe('succeeded');
      if (r.kind === 'succeeded') expect(r.prequote).toEqual(q);
    }
    expect(
      await p.deliveryPrequote.count({
        where: { idempotencyRecordId: winner.lease.recordId },
      }),
    ).toBe(1);
    await expect(
      service.publish(winner.lease, conditions, evidence(), 900000),
    ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
    await expect(
      service.fail(winner.lease, 'TOO_LATE', false),
    ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
  });
  it('conflicts with changed body, legacy keys, in-progress/failed/succeeded durable keys; never calls incompatible loader', async () => {
    const k = key();
    const a = await acquired(k);
    const load = vi.fn();
    const create = vi.fn();
    const oldScope = {
      integrationClientId: clients[0],
      key: k,
      operation: 'delivery_requests.create',
      resourceType: 'DeliveryRequest',
    };
    await expect(
      legacy.execute(oldScope, conditions, create, load),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      legacy.execute(
        {
          ...oldScope,
          operation: PREQUOTE_OPERATION,
          resourceType: 'DeliveryPrequote',
        },
        normalizePrequoteConditions(conditions),
        create,
        load,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.reserve(
        clients[0],
        k,
        { ...conditions, packages: [{ category: 'FOOD', quantity: 2 }] },
        policy,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await service.fail(a.lease, 'FINAL', false);
    await expect(
      legacy.execute(oldScope, conditions, create, load),
    ).rejects.toMatchObject({ status: 409 });
    const done = await acquired();
    await service.publish(done.lease, conditions, evidence(), 5000);
    await expect(
      legacy.execute({ ...oldScope, key: done.key }, conditions, create, load),
    ).rejects.toMatchObject({ status: 409 });
    const oldKey = key();
    await legacy.execute(
      { ...oldScope, key: oldKey },
      { x: 1 },
      async () => {},
      async (id) => id,
    );
    await expect(
      service.reserve(clients[0], oldKey, conditions, policy),
    ).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it('isolates integrations and refuses a forged tenant on lease mutation', async () => {
    const k = key();
    const a = await acquired(k);
    const b = await acquired(k, policy, clients[1]);
    expect(a.resourceId).not.toBe(b.resourceId);
    await expect(
      service.fail(
        { ...a.lease, integrationClientId: clients[1] },
        'BAD',
        false,
      ),
    ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
    await expect(
      service.publish(
        { ...a.lease, integrationClientId: clients[1] },
        conditions,
        evidence(),
        5000,
      ),
    ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
  });
  it('recovers an expired lease once under two concurrent recoverers and fences every old-owner mutation', async () => {
    const a = await acquired(key(), { leaseMs: 100, maxAttempts: 3 });
    await wait(160);
    await expect(service.fail(a.lease, 'STALE', true)).rejects.toMatchObject({
      code: 'PREQUOTE_LEASE_LOST',
    });
    const outcomes = await Promise.all([
      service.reserve(clients[0], a.key, conditions, policy),
      service.reserve(clients[0], a.key, conditions, policy),
    ]);
    expect(outcomes.map((r) => r.kind).sort()).toEqual([
      'acquired',
      'in_progress',
    ]);
    const b = outcomes.find((r) => r.kind === 'acquired')!;
    if (b.kind !== 'acquired') throw Error();
    expect(b.lease.version).toBe(2);
    expect(b.lease.owner).not.toBe(a.lease.owner);
    await expect(
      service.publish(a.lease, conditions, evidence(), 5000),
    ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
    await expect(service.fail(a.lease, 'STALE', false)).rejects.toMatchObject({
      code: 'PREQUOTE_LEASE_LOST',
    });
    await service.publish(b.lease, conditions, evidence(), 5000);
  });
  it('bounds retries, keeps terminal failures and exhausts expired attempts without reopening', async () => {
    const a = await acquired(key(), { ...policy, maxAttempts: 2 });
    await service.fail(a.lease, 'TRANSIENT', true);
    const b = await acquired(a.key);
    expect(b.lease.version).toBe(2);
    await service.fail(b.lease, 'TRANSIENT', true);
    expect(
      await service.reserve(clients[0], a.key, conditions, policy),
    ).toEqual({ kind: 'failed', errorCode: 'TRANSIENT' });
    const final = await acquired();
    await service.fail(final.lease, 'TERMINAL', false);
    expect(
      (await service.reserve(clients[0], final.key, conditions, policy)).kind,
    ).toBe('failed');
    const expired = await acquired(key(), { leaseMs: 100, maxAttempts: 1 });
    await wait(160);
    expect(
      await service.reserve(clients[0], expired.key, conditions, policy),
    ).toEqual({ kind: 'failed', errorCode: 'ATTEMPTS_EXHAUSTED' });
  });
  it('rolls back insertion when success recording fails, then allows the same current owner to publish', async () => {
    const a = await acquired();
    let inserted = false;
    const faultDb = {
      $transaction: (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        p.$transaction(async (tx) =>
          work(
            new Proxy(tx, {
              get(target, prop) {
                if (prop === 'deliveryPrequote')
                  return {
                    ...target.deliveryPrequote,
                    create: async (args: Prisma.DeliveryPrequoteCreateArgs) => {
                      const q = await target.deliveryPrequote.create(args);
                      inserted = true;
                      return q;
                    },
                  };
                if (prop === 'apiIdempotencyExecution')
                  return {
                    ...target.apiIdempotencyExecution,
                    update: async () => {
                      throw Error('CONTROLLED_AFTER_INSERT');
                    },
                  };
                return Reflect.get(target, prop);
              },
            }),
          ),
        ),
    } as unknown as PrismaService;
    await expect(
      new PrequotePersistenceService(faultDb, zones, plans).publish(
        a.lease,
        conditions,
        evidence(),
        5000,
      ),
    ).rejects.toThrow('CONTROLLED_AFTER_INSERT');
    expect(inserted).toBe(true);
    expect(
      await p.deliveryPrequote.findUnique({ where: { id: a.resourceId } }),
    ).toBeNull();
    expect(
      (
        await p.apiIdempotencyExecution.findUniqueOrThrow({
          where: { recordId: a.lease.recordId },
        })
      ).state,
    ).toBe('PROCESSING');
    await service.publish(a.lease, conditions, evidence(), 5000);
  });
  it('failure before publication creates no offer and can be recovered', async () => {
    const a = await acquired();
    await service.fail(a.lease, 'SIMULATED_WORK_FAILED', true);
    expect(
      await p.deliveryPrequote.findUnique({ where: { id: a.resourceId } }),
    ).toBeNull();
    const b = await acquired(a.key);
    await service.publish(b.lease, conditions, evidence(), 5000);
  });
  it('rechecks lease after waiting for publication locks and uses DB issuance time', async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id=${zoneId}::uuid FOR UPDATE`;
      entered();
      await gate;
    });
    await ready;
    try {
      const a = await acquired(key(), { leaseMs: 150, maxAttempts: 3 });
      const pending = service
        .publish(a.lease, conditions, evidence(), 5000)
        .then(
          () => null,
          (error) => error,
        );
      await wait(220);
      release();
      await blocker;
      expect(await pending).toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
      expect(
        await p.deliveryPrequote.findUnique({ where: { id: a.resourceId } }),
      ).toBeNull();
    } finally {
      release();
      await blocker;
    }
  });
  it('database rejects a failure without an error code and cross-plan band references', async () => {
    const a = await acquired();
    await expect(
      p.apiIdempotencyExecution.update({
        where: { recordId: a.lease.recordId },
        data: { state: 'FAILED', errorCode: null },
      }),
    ).rejects.toThrow('Execution_values');
    const other = await p.ratePlan.create({
      data: {
        serviceZoneId: zoneId,
        serviceType: 'LOCAL_DELIVERY',
        version: 2,
        status: 'DRAFT',
        quoteValidityMinutes: 15,
        currency: 'MXN',
      },
    });
    await expect(
      forged(a.lease, a.resourceId, { ratePlanId: other.id }),
    ).rejects.toThrow('PREQUOTE_EVIDENCE_INVALID');
  });
  it('refuses a changed publication payload without losing its reservation', async () => {
    const a = await acquired();
    await expect(
      service.publish(
        a.lease,
        { ...conditions, packages: [{ category: 'FOOD', quantity: 2 }] },
        evidence(),
        5000,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await p.deliveryPrequote.findUnique({ where: { id: a.resourceId } }),
    ).toBeNull();
    await service.publish(a.lease, conditions, evidence(), 5000);
  });
  it('SQL rejects success without its resource and guards terminal execution and key identity', async () => {
    const a = await acquired();
    await expect(
      p.apiIdempotencyExecution.update({
        where: { recordId: a.lease.recordId },
        data: { state: 'SUCCEEDED' },
      }),
    ).rejects.toThrow('PREQUOTE_ATOMIC_RESULT');
    await service.fail(a.lease, 'FINAL', false);
    await expect(
      p.apiIdempotencyExecution.update({
        where: { recordId: a.lease.recordId },
        data: { state: 'PROCESSING' },
      }),
    ).rejects.toThrow('EXECUTION_TERMINAL_OR_IDENTITY');
    await expect(
      p.apiIdempotencyRecord.update({
        where: { id: a.lease.recordId },
        data: { resourceId: randomUUID() },
      }),
    ).rejects.toThrow('DURABLE_KEY_IMMUTABLE');
    await expect(
      p.apiIdempotencyExecution.delete({
        where: { recordId: a.lease.recordId },
      }),
    ).rejects.toThrow('EXECUTION_IMMUTABLE');
  });
  async function forged(
    lease: PrequoteLease,
    resourceId: string,
    overrides: Record<string, unknown>,
  ) {
    return p.$transaction(async (tx) => {
      const [clock] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
      const z = await tx.serviceZone.findUniqueOrThrow({
        where: { id: zoneId },
      });
      await tx.deliveryPrequote.create({
        data: {
          id: resourceId,
          publicId: await nextPublicId(tx, 'MPQ'),
          idempotencyRecordId: lease.recordId,
          ...ownerFields(lease.integrationClientId),
          conditionsVersion: 1,
          conditions: normalizePrequoteConditions(conditions),
          serviceType: 'LOCAL_DELIVERY',
          serviceZoneId: zoneId,
          zoneCode: z.code,
          zoneName: z.name,
          zoneBoundary: z.boundary as Prisma.InputJsonValue,
          ratePlanId: planId,
          rateBandId: bandId,
          distanceMeters: 1200,
          durationSeconds: 60,
          amount: '25.10',
          currency: 'MXN',
          routingProvider: 'test',
          routeCalculatedAt: clock.now,
          issuedAt: clock.now,
          expiresAt: new Date(clock.now.getTime() + 5000),
          ...overrides,
        },
      });
      await tx.apiIdempotencyExecution.update({
        where: { recordId: lease.recordId },
        data: { state: 'SUCCEEDED' },
      });
    });
  }
  it.each([
    { amount: '1.00' },
    { currency: 'USD' },
    { distanceMeters: 10000 },
    { durationSeconds: -1 },
    { conditionsVersion: 2 },
    { integrationClientId: clients[1] },
    { zoneName: 'forged' },
    { zoneBoundary: {} },
    { expiresAt: new Date('2000-01-01') },
    { routeCalculatedAt: new Date('2099-01-01') },
    { conditions: { financialContext: {} } },
  ])('SQL rejects forged snapshot %#', async (override) => {
    const a = await acquired();
    await expect(forged(a.lease, a.resourceId, override)).rejects.toThrow(
      /PREQUOTE_EVIDENCE_INVALID|Prequote_values|Prequote_conditions/,
    );
    expect(
      await p.deliveryPrequote.findUnique({ where: { id: a.resourceId } }),
    ).toBeNull();
  });
  it('SQL rejects uncanonical/sensitive conditions and agrees with the single normalizer on valid conditions', async () => {
    const canonical = normalizePrequoteConditions({
      ...conditions,
      packages: [
        { category: 'FOOD', quantity: 2 },
        { category: 'FOOD', quantity: 1 },
        { category: 'FOOD', quantity: 1 },
      ],
    });
    const [valid] = await p.$queryRaw<
      { valid: boolean }[]
    >`SELECT prequote_conditions_valid(${JSON.stringify(canonical)}::jsonb) AS valid`;
    expect(valid.valid).toBe(true);
    for (const bad of [
      { ...canonical, financialContext: {} },
      { ...canonical, packages: [...canonical.packages].reverse() },
      {
        ...canonical,
        stops: [
          { ...canonical.stops[0], latitude: 1.1234567 },
          canonical.stops[1],
        ],
      },
    ]) {
      const [v] = await p.$queryRaw<
        { valid: boolean }[]
      >`SELECT prequote_conditions_valid(${JSON.stringify(bad)}::jsonb) AS valid`;
      expect(v.valid).toBe(false);
    }
  });
  it('immutability preserves historical zone evidence and replay never recalculates or renews', async () => {
    const a = await acquired();
    const q = await service.publish(a.lease, conditions, evidence(), 1);
    await expect(
      p.deliveryPrequote.update({ where: { id: q.id }, data: { amount: '1' } }),
    ).rejects.toThrow('PREQUOTE_IMMUTABLE');
    await expect(
      p.deliveryPrequote.delete({ where: { id: q.id } }),
    ).rejects.toThrow('PREQUOTE_IMMUTABLE');
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { name: 'Changed after publication', status: 'INACTIVE' },
    });
    const r = await service.reserve(clients[0], a.key, conditions, policy);
    expect(r.kind).toBe('succeeded');
    if (r.kind === 'succeeded') {
      expect(r.prequote).toEqual(q);
      expect(prequoteEffectiveStatus(r.prequote, new Date())).toBe('EXPIRED');
    }
    expect(await operationalCounts()).toEqual(baseline);
  });
});
