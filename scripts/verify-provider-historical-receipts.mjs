import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { ExecutionService } from '../dist/delivery-execution/execution.service.js';
// Build the archived d440aef backend separately; never load a running old writer.
assert(process.argv[2], 'Pass path to the archived execution.service.js');
const { ExecutionService: HistoricalService } = await import(
  pathToFileURL(resolve(process.argv[2])).href
);
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test'),
  'Explicit local isolated TEST_DATABASE_URL required',
);
mkdirSync('.tmp/provider-history-check', { recursive: true });
const db = new PrismaClient({ datasourceUrl: url.href });
try {
  const receipts = await db.$queryRawUnsafe(
    `SELECT c."dispatchId",c."actorUserId",c.key,c.response,a."providerId" FROM "DeliveryExecutionCommand" c JOIN "DeliveryAssignment" a ON a.id::text=c.response->>'activeAssignmentId' JOIN "User" u ON u.id=c."actorUserId" JOIN "ProviderMembership" m ON m."userId"=u.id AND m."providerId"=a."providerId" WHERE c.operation='ADVANCE' AND c.state='APPLIED' AND u.role='PROVIDER_ADMIN' AND u.active`,
  );
  assert(receipts.length > 0);
  const service = new ExecutionService(db),
    historical = new HistoricalService(db);
  const before = {
    events: await db.deliveryExecutionEvent.count(),
    resolutions: await db.deliveryCustodyResolution.count(),
    ledger: await db.creditLedgerEntry.count(),
  };
  for (const r of receipts) {
    const actor = {
      id: r.actorUserId,
      role: 'PROVIDER_ADMIN',
      providerId: r.providerId,
    };
    const read = await service.reconcileProviderAdvance(
      r.dispatchId,
      actor,
      r.key,
    );
    assert.equal(read.state, 'APPLIED');
    assert.equal(read.appliedRevision, r.response.revision);
    assert.equal(read.canStartNewAttempt, false);
    assert.deepEqual(
      await service.reconcileProviderAdvance(r.dispatchId, actor, r.key, true),
      read,
    );
  }
  const r = receipts[0],
    actor = {
      id: r.actorUserId,
      role: 'PROVIDER_ADMIN',
      providerId: r.providerId,
    },
    key = randomUUID();
  assert.equal(
    (await service.reconcileProviderAdvance(r.dispatchId, actor, key)).state,
    'PENDING_OR_UNKNOWN',
  );
  const close = await service.reconcileProviderAdvance(
    r.dispatchId,
    actor,
    key,
    true,
  );
  assert.equal(close.state, 'CLOSED_NO_EFFECTS');
  // Execute the real pre-authority command after closure; its original namespace must block it.
  let code;
  try {
    await historical.advance(r.dispatchId, actor, key, {
      assignmentId: r.response.activeAssignmentId,
      expectedRevision: r.response.revision,
      phase: 'TO_PICKUP',
    });
  } catch (e) {
    code = e.getResponse?.().code;
  }
  assert.equal(code, 'EXECUTION_ATTEMPT_CLOSED');
  const after = {
    events: await db.deliveryExecutionEvent.count(),
    resolutions: await db.deliveryCustodyResolution.count(),
    ledger: await db.creditLedgerEntry.count(),
  };
  assert.deepEqual(after, before);
  const result = {
    historicalCommit: 'd440aef',
    appliedReceipts: receipts.length,
    appliedReadAndClose: true,
    originalLateCommandCode: code,
    noOperationalOrLedgerChange: true,
  };
  writeFileSync(
    '.tmp/provider-history-check/historical-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  await db.$disconnect();
}
