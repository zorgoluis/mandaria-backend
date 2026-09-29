import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { writeFileSync, mkdirSync } from 'node:fs';
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw Error('TEST_DATABASE_URL required');
const url = new URL(raw);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('Local isolated _test database required');
const p = new PrismaClient({ datasourceUrl: raw });
try {
  const [scan] = await p.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM "PrequoteConversion" c LEFT JOIN "DeliveryRequest" r ON r.id=c."deliveryRequestId" LEFT JOIN "DeliveryQuote" q ON q.id=c."deliveryQuoteId" LEFT JOIN "ApiIdempotencyRecord" k ON k.id=c."idempotencyRecordId" WHERE r.id IS NULL OR q.id IS NULL OR k.id IS NULL OR k."resourceId"<>c.id OR k.operation<>'delivery_prequotes.convert' OR k."resourceType"<>'PrequoteConversion' OR k."integrationClientId"<>c."integrationClientId" OR r."integrationClientId"<>c."integrationClientId") AS invalid_links,
    (SELECT count(*)::int FROM "ApiIdempotencyRecord" k LEFT JOIN "PrequoteConversion" c ON c."idempotencyRecordId"=k.id WHERE (k.operation='delivery_prequotes.convert' OR k."resourceType"='PrequoteConversion') AND c.id IS NULL) AS orphan_keys,
    (SELECT count(*)::int FROM "ApiIdempotencyExecution" e JOIN "PrequoteConversion" c ON c."idempotencyRecordId"=e."recordId") AS conversion_executions,
    (SELECT count(*)::int FROM "Dispatch" d JOIN "PrequoteConversion" c ON c."deliveryRequestId"=d."deliveryRequestId" OR c."deliveryQuoteId"=d."deliveryQuoteId") AS premature_dispatches,
    (SELECT count(*)::int FROM "DeliveryQuote" q JOIN "PrequoteConversion" c ON c."deliveryRequestId"=q."deliveryRequestId" JOIN "DeliveryPrequote" p ON p.id=c."prequoteId" WHERE q.id<>c."deliveryQuoteId" OR q.status='ACCEPTED' OR q."acceptedAt" IS NOT NULL OR ROW(q.amount,q.currency,q."expiresAt",q."serviceType",q."serviceZoneId",q."ratePlanId",q."rateBandId",q."distanceMeters",q."durationSeconds",q."routingProvider",q."routeCalculatedAt") IS DISTINCT FROM ROW(p.amount,p.currency,p."expiresAt",p."serviceType",p."serviceZoneId",p."ratePlanId",p."rateBandId",p."distanceMeters",p."durationSeconds",p."routingProvider",p."routeCalculatedAt")) AS invalid_quotes,
    (SELECT count(*)::int FROM "PrequoteConversion" c WHERE (SELECT array_agg(id ORDER BY id) FROM "DeliveryStop" WHERE "deliveryRequestId"=c."deliveryRequestId") IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."stopIds") v) OR (SELECT array_agg(id ORDER BY id) FROM "DeliveryPackage" WHERE "deliveryRequestId"=c."deliveryRequestId") IS DISTINCT FROM (SELECT array_agg(v ORDER BY v) FROM unnest(c."packageIds") v) OR NOT EXISTS(SELECT 1 FROM "DeliveryFinancialContext" f WHERE f.id=c."financialContextId" AND f."deliveryRequestId"=c."deliveryRequestId" AND f."goodsPaymentMode"='PREPAID' AND f.currency='MXN')) AS invalid_manifests,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'B2_fault_%' OR tgname LIKE 'B3_fault_%') AS fault_triggers,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'Conversion_%' AND tgenabled<>'O') AS disabled_integrity_triggers,
    (SELECT count(*)::int FROM "IntegrationCredential" cr JOIN "IntegrationClient" i ON i.id=cr."clientId" WHERE (i.code LIKE 'B2_%' OR i.code LIKE 'B3_%') AND cr.status='ACTIVE') AS active_fixture_credentials,
    (SELECT count(*)::int FROM "ServiceZone" WHERE (code LIKE 'B2_%' OR code LIKE 'B3_%') AND status='ACTIVE') AS active_fixture_zones`);
  const catalog =
    await p.$queryRaw`SELECT tgname, tgenabled, tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname LIKE 'Conversion_%' ORDER BY tgname`;
  mkdirSync('.tmp/b3', { recursive: true });
  writeFileSync(
    '.tmp/b3/db-scan.json',
    JSON.stringify({ scan, catalog }, null, 2),
  );
  console.log(JSON.stringify({ scan, integrityTriggers: catalog.length }));
  if (Object.values(scan).some((v) => v !== 0) || catalog.length < 8)
    process.exitCode = 1;
} finally {
  await p.$disconnect();
}
