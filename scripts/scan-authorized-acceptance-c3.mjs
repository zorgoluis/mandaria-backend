import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { closeDispatchesForCancelledRequest } from '../dist/dispatch/dispatch-policy.js';
const state = JSON.parse(readFileSync('.tmp/c3/databases.json', 'utf8'));
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local test only');
const output = {};
for (const name of Object.values(state)) {
  if (!/^mandaria_c3_(clean|upgrade)_[a-f0-9]+_test$/.test(name))
    throw Error('Invalid isolated database');
  source.pathname = '/' + name;
  const p = new PrismaClient({ datasourceUrl: source.toString() });
  try {
    const requests = await p.deliveryRequest.findMany({
      where: {
        integrationClient: { code: { startsWith: 'C3_' } },
        status: 'CREATED',
      },
      select: { id: true },
    });
    for (const r of requests)
      await p.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${r.id}::uuid FOR UPDATE`;
        const now = new Date();
        await tx.deliveryRequest.update({
          where: { id: r.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReason: 'C3 fixture cleanup',
          },
        });
        const qs = await tx.deliveryQuote.findMany({
          where: { deliveryRequestId: r.id, status: 'OFFERED' },
        });
        for (const q of qs)
          await tx.deliveryQuote.update({
            where: { id: q.id },
            data:
              q.expiresAt <= now
                ? { status: 'EXPIRED', expiredAt: now }
                : {
                    status: 'CANCELLED',
                    cancelledAt: now,
                    cancellationReason: 'C3 fixture cleanup',
                  },
          });
        await closeDispatchesForCancelledRequest(tx, r.id, now);
      });
    await p.integrationCredential.updateMany({
      where: { client: { code: { startsWith: 'C3_' } }, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await p.serviceZone.updateMany({
      where: { code: { startsWith: 'C3_' } },
      data: { status: 'INACTIVE' },
    });
    await p.deliveryProvider.updateMany({
      where: { code: { startsWith: 'C3_' } },
      data: { status: 'SUSPENDED' },
    });
    await p.user.updateMany({
      where: { email: { startsWith: 'c3-', endsWith: '@fixture.test' } },
      data: { active: false },
    });
    const [scan] = await p.$queryRaw`SELECT
   (SELECT count(*)::int FROM "AuthorizedQuoteAcceptance" a LEFT JOIN "Dispatch" d ON d.id=a."dispatchId" LEFT JOIN "DeliveryQuote" q ON q.id=a."deliveryQuoteId" LEFT JOIN "ApiIdempotencyRecord" k ON k.id=a."idempotencyRecordId" WHERE d.id IS NULL OR q.id IS NULL OR k.id IS NULL OR q.status<>'ACCEPTED' OR q."acceptedAt"<>a."acceptedAt" OR d."deliveryQuoteId"<>q.id OR d."deliveryRequestId"<>a."deliveryRequestId" OR k."resourceId"<>a.id OR a."authorizedAmount"<>q.amount OR a."authorizedExpiresAt"<>q."expiresAt") AS "invalidEvidence",
   (SELECT count(*)::int FROM "DeliveryQuote" q JOIN "PrequoteConversion" c ON c."deliveryQuoteId"=q.id LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."deliveryQuoteId"=q.id WHERE q.status='ACCEPTED' AND a.id IS NULL) AS "acceptedWithoutEvidence",
   (SELECT count(*)::int FROM "Dispatch" d JOIN "PrequoteConversion" c ON c."deliveryRequestId"=d."deliveryRequestId" LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."dispatchId"=d.id WHERE a.id IS NULL) AS "dispatchWithoutEvidence",
   (SELECT count(*)::int FROM "ApiIdempotencyRecord" k LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."idempotencyRecordId"=k.id WHERE (k.operation='delivery_quotes.accept_authorized' OR k."resourceType"='AuthorizedQuoteAcceptance') AND a.id IS NULL) AS "orphanKeys",
   (SELECT count(*)::int FROM "CreditAccount" WHERE balance<0) AS "negativeBalances",
   (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('C3_abort_snapshot','C3_delay_snapshot','C3_hold_accept','C3_failpoint')) AS "temporaryTriggers"`;
    for (const n of Object.values(scan)) assert.equal(n, 0);
    output[name] = {
      scan,
      cancelledFixtures: requests.length,
      remainingActiveCredentials: await p.integrationCredential.count({
        where: { client: { code: { startsWith: 'C3_' } }, status: 'ACTIVE' },
      }),
      retainedEvidence: await p.authorizedQuoteAcceptance.count(),
    };
  } finally {
    await p.$disconnect();
  }
}
writeFileSync(
  'docs/checks/v1.13-c3-scan.json',
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  'C3 invariant scan passed; histories retained, synthetic C3 credentials disabled',
);
