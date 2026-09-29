import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local only');
const state = JSON.parse(readFileSync('.tmp/c3/databases.json'));
const reg = JSON.parse(readFileSync('docs/checks/v1.13-c3-regression.json'));
const names = [
  ...new Set([...Object.values(state), ...reg.attempts.map((a) => a.database)]),
];
const results = [];
for (const name of names) {
  if (!/^mandaria_c3_(clean|upgrade|reg)_[a-f0-9]+_test$/.test(name))
    throw Error('Isolated C3 destination required');
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
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgenabled<>'O' OR tgname LIKE 'C3_%')) AS "disabledOrTemporaryTriggers"`;
    results.push({ database: name, scan });
    for (const n of Object.values(scan)) assert.equal(n, 0);
  } finally {
    await p.$disconnect();
  }
}
writeFileSync(
  'docs/checks/v1.13-c3-all-database-scan.json',
  JSON.stringify(results, null, 2) + '\n',
);
console.log(JSON.stringify({ databases: results.length, violations: 0 }));
