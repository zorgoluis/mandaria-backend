import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local only');
const state = JSON.parse(readFileSync('.tmp/c4/databases.json'));
const reg = JSON.parse(readFileSync('docs/checks/v1.13-c4-regression.json'));
const names = [
  ...new Set([...Object.values(state), ...reg.attempts.map((a) => a.database)]),
];
const results = [];
for (const name of names) {
  if (!/^mandaria_c4_(clean|upgrade|reg)_[a-f0-9]+_test$/.test(name))
    throw Error('Isolated C4 destination required');
  const u = new URL(source);
  u.pathname = '/' + name;
  const p = new PrismaClient({ datasourceUrl: u.toString() });
  try {
    const [scan] = await p.$queryRaw`SELECT
  (SELECT count(*)::int FROM "AuthorizedQuoteAcceptance" a LEFT JOIN "Dispatch" d ON d.id=a."dispatchId" LEFT JOIN "DeliveryQuote" q ON q.id=a."deliveryQuoteId" LEFT JOIN "ApiIdempotencyRecord" k ON k.id=a."idempotencyRecordId" WHERE d.id IS NULL OR q.id IS NULL OR k.id IS NULL OR q.status<>'ACCEPTED' OR q."acceptedAt"<>a."acceptedAt" OR d."deliveryQuoteId"<>q.id OR d."deliveryRequestId"<>a."deliveryRequestId" OR k."resourceId"<>a.id OR a."authorizedAmount"<>q.amount OR a."authorizedExpiresAt"<>q."expiresAt") AS "invalidEvidence",
  (SELECT count(*)::int FROM "DeliveryQuote" q JOIN "PrequoteConversion" c ON c."deliveryQuoteId"=q.id LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."deliveryQuoteId"=q.id WHERE q.status='ACCEPTED' AND a.id IS NULL) AS "acceptedWithoutEvidence",
  (SELECT count(*)::int FROM "Dispatch" d JOIN "PrequoteConversion" c ON c."deliveryRequestId"=d."deliveryRequestId" LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."dispatchId"=d.id WHERE a.id IS NULL) AS "dispatchWithoutEvidence",
  (SELECT count(*)::int FROM "ApiIdempotencyRecord" k LEFT JOIN "AuthorizedQuoteAcceptance" a ON a."idempotencyRecordId"=k.id WHERE (k.operation='delivery_quotes.accept_authorized' OR k."resourceType"='AuthorizedQuoteAcceptance') AND a.id IS NULL) AS "orphanKeys",
  (SELECT count(*)::int FROM "DispatchCandidate" c LEFT JOIN "Dispatch" d ON d.id=c."dispatchId" WHERE d.id IS NULL) AS "orphanCandidates",
  (SELECT count(*)::int FROM "AuthorizedQuoteAcceptance" a WHERE (SELECT count(*) FROM "DispatchCreditSnapshot" s WHERE s."dispatchId"=a."dispatchId")<>2) AS "incompleteSnapshots",
  (SELECT count(*)::int FROM "CreditAccount" WHERE balance<0) AS "negativeBalances",
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgenabled<>'O' OR tgname LIKE 'C4_%')) AS "disabledOrTemporaryTriggers"`;
    const [extended] = await p.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM "DeliveryPrequote" p LEFT JOIN "ApiIdempotencyRecord" k ON k.id=p."idempotencyRecordId" WHERE k.id IS NULL OR k."resourceId"<>p.id OR k."integrationClientId"<>p."integrationClientId" OR p."expiresAt"<=p."issuedAt") AS "invalidPrequotes",
      (SELECT count(*)::int FROM "PrequoteConversion" c LEFT JOIN "DeliveryRequest" r ON r.id=c."deliveryRequestId" LEFT JOIN "DeliveryQuote" q ON q.id=c."deliveryQuoteId" LEFT JOIN "ApiIdempotencyRecord" k ON k.id=c."idempotencyRecordId" WHERE r.id IS NULL OR q.id IS NULL OR k.id IS NULL OR k."resourceId"<>c.id OR k.operation<>'delivery_prequotes.convert' OR k."resourceType"<>'PrequoteConversion' OR k."integrationClientId"<>c."integrationClientId" OR r."integrationClientId"<>c."integrationClientId") AS "invalidConversionLinks",
      (SELECT count(*)::int FROM "ApiIdempotencyRecord" k LEFT JOIN "PrequoteConversion" c ON c."idempotencyRecordId"=k.id WHERE (k.operation='delivery_prequotes.convert' OR k."resourceType"='PrequoteConversion') AND c.id IS NULL) AS "orphanConversionKeys",
      (SELECT count(*)::int FROM "ApiIdempotencyExecution" e JOIN "PrequoteConversion" c ON c."idempotencyRecordId"=e."recordId") AS "conversionExecutions",
      (SELECT count(*)::int FROM "DeliveryQuote" q JOIN "PrequoteConversion" c ON c."deliveryRequestId"=q."deliveryRequestId" JOIN "DeliveryPrequote" p ON p.id=c."prequoteId" WHERE q.id<>c."deliveryQuoteId" OR ROW(q.amount,q.currency,q."expiresAt",q."serviceType",q."serviceZoneId",q."ratePlanId",q."rateBandId",q."distanceMeters",q."durationSeconds",q."routingProvider",q."routeCalculatedAt") IS DISTINCT FROM ROW(p.amount,p.currency,p."expiresAt",p."serviceType",p."serviceZoneId",p."ratePlanId",p."rateBandId",p."distanceMeters",p."durationSeconds",p."routingProvider",p."routeCalculatedAt")) AS "changedConversionSnapshot",
      (SELECT count(*)::int FROM "PrequoteConversion" c WHERE (SELECT array_agg(id ORDER BY id) FROM "DeliveryStop" WHERE "deliveryRequestId"=c."deliveryRequestId") IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."stopIds") v) OR (SELECT array_agg(id ORDER BY id) FROM "DeliveryPackage" WHERE "deliveryRequestId"=c."deliveryRequestId") IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."packageIds") v) OR NOT EXISTS(SELECT 1 FROM "DeliveryFinancialContext" f WHERE f.id=c."financialContextId" AND f."deliveryRequestId"=c."deliveryRequestId" AND f."goodsPaymentMode"='PREPAID' AND f.currency='MXN')) AS "invalidConversionManifests",
      (SELECT count(*)::int FROM "AuthorizedQuoteAcceptance" a JOIN "PrequoteConversion" c ON c.id=a."conversionId" JOIN "DeliveryQuote" q ON q.id=a."deliveryQuoteId" JOIN "ApiIdempotencyRecord" k ON k.id=a."idempotencyRecordId" WHERE a."integrationClientId"<>c."integrationClientId" OR a."deliveryRequestId"<>c."deliveryRequestId" OR a."deliveryQuoteId"<>c."deliveryQuoteId" OR k.operation<>'delivery_quotes.accept_authorized' OR k."resourceType"<>'AuthorizedQuoteAcceptance' OR k."integrationClientId"<>a."integrationClientId" OR a."authorizedCurrency"<>q.currency OR a."authorizedAt"<c."convertedAt" OR a."acceptedAt">=q."expiresAt") AS "invalidAuthorizationTuple",
      (SELECT count(*)::int FROM "CreditLedgerEntry" WHERE "balanceAfter"<>"balanceBefore"+amount OR "balanceBefore"<0 OR "balanceAfter"<0) AS "invalidLedgerArithmetic",
      (SELECT count(*)::int FROM (SELECT "balanceBefore",coalesce(lag("balanceAfter") OVER (PARTITION BY "creditAccountId" ORDER BY sequence),0) previous FROM "CreditLedgerEntry") t WHERE "balanceBefore"<>previous) AS "brokenLedgerChain",
      (SELECT count(*)::int FROM "CreditAccount" a WHERE a.balance<>coalesce((SELECT sum(l.amount) FROM "CreditLedgerEntry" l WHERE l."creditAccountId"=a.id),0)) AS "balanceLedgerMismatch",
      (SELECT count(*)::int FROM (SELECT "creditAccountId","referenceId" FROM "CreditLedgerEntry" WHERE type='SERVICE_AWARD' GROUP BY 1,2 HAVING count(*)<>1) t) AS "duplicateAwards",
      (SELECT count(*)::int FROM "CreditLedgerEntry" r LEFT JOIN "CreditLedgerEntry" a ON a.id=r."reversesEntryId" WHERE r.type='SERVICE_REFUND' AND (a.id IS NULL OR a.type<>'SERVICE_AWARD' OR r.amount<>-a.amount OR r."creditAccountId"<>a."creditAccountId" OR r."referenceId" IS DISTINCT FROM a."referenceId")) AS "invalidRefunds",
      (SELECT count(*)::int FROM (SELECT "reversesEntryId" FROM "CreditLedgerEntry" WHERE type='SERVICE_REFUND' GROUP BY 1 HAVING count(*)<>1) t) AS "duplicateRefunds",
      (SELECT count(*)::int FROM "B2bOutboxEvent" e LEFT JOIN "Dispatch" d ON d.id=e."dispatchId" WHERE e.type='DELIVERY_COMPLETED' AND (d.id IS NULL OR d.status<>'DELIVERED' OR d."deliveredAt" IS DISTINCT FROM e."occurredAt" OR d."deliveryRequestId"<>e."deliveryRequestId")) AS "invalidCompletionOutbox",
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgenabled<>'O' OR tgname ~* '(fault|c[234]_|b[234]_)')) AS "temporaryOrDisabledGuards"`);
    // Reconcile both directions against durable operational history, respecting explicit
    // LEGACY/pre-enforcement exemptions. This function is read-only and is also the
    // existing database constraint's implementation, not an independent algorithm.
    await p.$queryRaw`SELECT "assert_dispatch_award_integrity"(id)::text FROM "Dispatch"`;
    const counts = {
      prequotes: await p.deliveryPrequote.count(),
      conversions: await p.prequoteConversion.count(),
      authorizations: await p.authorizedQuoteAcceptance.count(),
      ledgerEntries: await p.creditLedgerEntry.count(),
      outbox: await p.b2bOutboxEvent.count(),
    };
    results.push({
      database: name,
      counts,
      scan: { ...scan, ...extended },
      awardIntegrityFunction: 'passed',
    });
    writeFileSync(
      'docs/checks/v1.13-c4-all-database-scan.json',
      JSON.stringify(results, null, 2) + '\n',
    );
    for (const [key, n] of Object.entries({ ...scan, ...extended }))
      assert.equal(n, 0, `${name}: ${key}`);
  } finally {
    await p.$disconnect();
  }
}
writeFileSync(
  'docs/checks/v1.13-c4-all-database-scan.json',
  JSON.stringify(results, null, 2) + '\n',
);
console.log(JSON.stringify({ databases: results.length, violations: 0 }));
