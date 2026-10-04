import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { publicDeliveryStatus } from '../dist/delivery-requests/public-delivery-tracking.js';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('Isolated local test database required');
const db = new PrismaClient({ datasourceUrl: url.toString() });
let owner: string, other: string;
beforeAll(async () => {
  owner = (
    await db.integrationClient.create({
      data: { name: 'Synthetic tracking', code: 'TRACK_' + randomUUID() },
    })
  ).id;
  other = (
    await db.integrationClient.create({
      data: { name: 'Synthetic other', code: 'TRACK_' + randomUUID() },
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});
const create = () =>
  db.deliveryRequest.create({
    data: {
      integrationClientId: owner,
      publicId:
        'MDR-' +
        String(Date.now()) +
        String(Math.floor(Math.random() * 100000)),
    },
  });

describe('Durable public tracking in PostgreSQL', () => {
  it('never assigned: stable read, isolation and rollback with no public effect', async () => {
    const r = await create();
    const initial = await publicDeliveryStatus(db, r.publicId, owner);
    expect(initial).toMatchObject({
      status: 'REQUESTED',
      trackingMode: null,
      assignmentState: 'NONE',
      terminalOutcome: null,
      publicVersion: '1',
    });
    expect(initial).not.toHaveProperty('executionProgress');
    await expect(publicDeliveryStatus(db, r.publicId, other)).rejects.toThrow(
      'Delivery request not found',
    );
    await expect(publicDeliveryStatus(db, 'MDR-000000', other)).rejects.toThrow(
      'Delivery request not found',
    );
    await expect(
      db.$transaction(async (tx) => {
        await tx.deliveryRequest.update({
          where: { id: r.id },
          data: { externalReference: 'rolled back' },
        });
        throw Error('controlled rollback');
      }),
    ).rejects.toThrow('controlled rollback');
    expect(await publicDeliveryStatus(db, r.publicId, owner)).toEqual(initial);
  });
  it('versions all public mutations, survives a new client and retains cancellation', async () => {
    const r = await create();
    const before = await publicDeliveryStatus(db, r.publicId, owner);
    const writes = Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        db.deliveryRequest.update({
          where: { id: r.id },
          data: { externalReference: 'demo-' + i },
        }),
      ),
    );
    const reads = Array.from({ length: 6 }, () =>
      publicDeliveryStatus(db, r.publicId, owner),
    );
    const responses = await Promise.all(reads);
    await writes;
    const after = await publicDeliveryStatus(db, r.publicId, owner);
    expect(BigInt(after.publicVersion)).toBeGreaterThan(
      BigInt(before.publicVersion),
    );
    const byVersion = new Map<string, string>();
    for (const response of [...responses, after]) {
      const version = String(response.publicVersion),
        value = JSON.stringify(response);
      if (byVersion.has(version)) expect(value).toBe(byVersion.get(version));
      byVersion.set(version, value);
    }
    const at = new Date();
    await db.deliveryRequest.update({
      where: { id: r.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: at,
        cancellationReason: 'Synthetic',
      },
    });
    const final = await publicDeliveryStatus(db, r.publicId, owner);
    expect(final).toMatchObject({
      terminalOutcome: { type: 'CANCELLED', occurredAt: at.toISOString() },
      assignmentState: 'NONE',
    });
    const restarted = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      expect(await publicDeliveryStatus(restarted, r.publicId, owner)).toEqual(
        final,
      );
    } finally {
      await restarted.$disconnect();
    }
  });
});
