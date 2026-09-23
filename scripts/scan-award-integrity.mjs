/** Read-only independent reconciliation. Uses DATABASE_URL; emits counts/ids, never credentials. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const dispatches = await prisma.dispatch.findMany({
    include: {
      candidates: true,
      deliveryAssignments: true,
      creditSnapshots: true,
      preEnforcementAwards: true,
    },
  });
  const accounts = await prisma.creditAccount.findMany({
    include: { independentDriverProfile: true },
  });
  const entries = await prisma.creditLedgerEntry.findMany({
    where: { type: 'SERVICE_AWARD' },
  });
  const violations = [];
  const awards = [];
  let legacy = 0;
  let transitional = 0;
  for (const d of dispatches) {
    if (d.creditMode === 'LEGACY') {
      legacy++;
      continue;
    }
    const history = [
      ...d.candidates
        .filter((c) => c.claimedAt)
        .map((c) => ({
          actor: 'PROVIDER',
          id: c.providerId,
          time: c.claimedAt,
        })),
      ...d.deliveryAssignments
        .filter((a) => a.mode === 'INDEPENDENT')
        .map((a) => ({
          actor: 'INDEPENDENT_DRIVER',
          id: a.driverId,
          time: a.assignedAt,
        })),
    ];
    if (
      d.claimedAt &&
      !history.some(
        (h) =>
          h.id === (d.claimedByProviderId ?? d.claimedByIndependentDriverId) &&
          +h.time === +d.claimedAt,
      )
    )
      violations.push({ kind: 'winner_without_history', dispatchId: d.id });
    for (const h of history) {
      const exemption = d.preEnforcementAwards.some(
        (x) =>
          x.actorType === h.actor &&
          x.actorId === h.id &&
          +x.awardedAt === +h.time,
      );
      if (exemption) {
        transitional++;
        continue;
      }
      const account = accounts.find(
        (a) =>
          a.ownerType === h.actor &&
          (h.actor === 'PROVIDER'
            ? a.providerId
            : a.independentDriverProfile?.driverId) === h.id,
      );
      const snapshot = d.creditSnapshots.find((s) => s.actorType === h.actor);
      const movements = entries.filter(
        (e) => e.referenceId === d.id && e.creditAccountId === account?.id,
      );
      if (
        !snapshot ||
        movements.length !== 1 ||
        movements[0]?.amount !== -snapshot.credits
      )
        violations.push({
          kind: 'required_award_mismatch',
          dispatchId: d.id,
          actor: h.actor,
        });
      awards.push({
        dispatchId: d.id,
        accountId: account?.id,
        credits: snapshot?.credits,
      });
    }
  }
  for (const entry of entries) {
    const matches = awards.filter(
      (a) =>
        a.dispatchId === entry.referenceId &&
        a.accountId === entry.creditAccountId &&
        -a.credits === entry.amount,
    );
    if (matches.length !== 1)
      violations.push({
        kind: 'orphan_or_wrong_payer_amount',
        entryId: entry.id,
      });
  }
  for (const account of accounts)
    if (account.balance < 0)
      violations.push({ kind: 'negative_balance', accountId: account.id });
  const keys = new Set();
  for (const e of entries) {
    const key = `${e.referenceId}/${e.creditAccountId}`;
    if (keys.has(key))
      violations.push({ kind: 'duplicate_award', entryId: e.id });
    keys.add(key);
  }
  console.log(
    JSON.stringify(
      {
        dispatches: dispatches.length,
        legacy,
        preEnforcementAwards: transitional,
        enforcedAwards: awards.length,
        ledgerAwards: entries.length,
        violations,
      },
      null,
      2,
    ),
  );
  if (violations.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
