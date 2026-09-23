import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { BASELINE_POLICY_AUTHOR } from './credit-policies.js';

/**
 * V1.10-D: claiming or taking a monetized Dispatch debits its frozen cost, so a suite whose case
 * expects a successful award has to say how many credits the actor has. These helpers make that
 * intention explicit and local to the test: fund exactly what the case needs, and leave the
 * accounts of insufficiency cases alone (they start at zero, like every real account does).
 *
 * The credits are added the only way the database accepts, a RECHARGE ledger entry, whose trigger
 * moves the balance; nothing here bypasses the V1.10-A guarantees. Only for *_test databases.
 */
async function recharge(
  prisma: PrismaClient,
  accountId: string,
  credits: number,
) {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>(
    'SELECT current_database() AS db',
  );
  if (!db.endsWith('_test'))
    throw new Error('test credit helpers only run on *_test databases');
  const author = await prisma.user.upsert({
    where: { email: BASELINE_POLICY_AUTHOR },
    update: {},
    create: {
      email: BASELINE_POLICY_AUTHOR,
      role: 'SUPER_ADMIN',
      active: false,
    },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    const [account] = await tx.$queryRaw<
      { balance: number }[]
    >`SELECT balance FROM "CreditAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
    if (!account) throw new Error(`credit account ${accountId} not found`);
    await tx.creditLedgerEntry.create({
      data: {
        creditAccountId: accountId,
        type: 'RECHARGE',
        amount: credits,
        balanceBefore: account.balance,
        balanceAfter: account.balance + credits,
        rechargeMethod: 'OTHER',
        reason: 'E2E funding',
        createdByUserId: author.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      },
    });
  });
  return (
    await prisma.creditAccount.findUniqueOrThrow({ where: { id: accountId } })
  ).balance;
}

/** Gives the provider exactly `credits` more credits and returns its new balance. */
export async function fundProvider(
  prisma: PrismaClient,
  providerId: string,
  credits: number,
) {
  const account = await prisma.creditAccount.findUniqueOrThrow({
    where: { providerId },
    select: { id: true },
  });
  return recharge(prisma, account.id, credits);
}

/** Gives the independent driver (by Driver id) exactly `credits` more credits. */
export async function fundIndependentDriver(
  prisma: PrismaClient,
  driverId: string,
  credits: number,
) {
  const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
    where: { driverId },
    select: { creditAccount: { select: { id: true } } },
  });
  if (!profile.creditAccount)
    throw new Error(`independent driver ${driverId} has no credit account`);
  return recharge(prisma, profile.creditAccount.id, credits);
}

/**
 * Leaves the account at exactly `target` credits, adding a RECHARGE or removing with an
 * ADMIN_ADJUSTMENT, so a concurrency case can state the balance it is really about.
 */
async function moveTo(prisma: PrismaClient, accountId: string, target: number) {
  const account = await prisma.creditAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  const delta = target - account.balance;
  if (!delta) return account.balance;
  if (delta > 0) return recharge(prisma, accountId, delta);
  const author = await prisma.user.findFirstOrThrow({
    where: { email: BASELINE_POLICY_AUTHOR },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<
      { balance: number }[]
    >`SELECT balance FROM "CreditAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
    await tx.creditLedgerEntry.create({
      data: {
        creditAccountId: accountId,
        type: 'ADMIN_ADJUSTMENT',
        amount: target - locked.balance,
        balanceBefore: locked.balance,
        balanceAfter: target,
        reason: 'E2E balance setup',
        createdByUserId: author.id,
        idempotencyKey: randomUUID(),
        requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      },
    });
  });
  return target;
}

/** Leaves the provider account at exactly `target` credits. */
export async function setProviderBalance(
  prisma: PrismaClient,
  providerId: string,
  target: number,
) {
  const account = await prisma.creditAccount.findUniqueOrThrow({
    where: { providerId },
    select: { id: true },
  });
  return moveTo(prisma, account.id, target);
}

/** Leaves the independent driver account at exactly `target` credits. */
export async function setIndependentBalance(
  prisma: PrismaClient,
  driverId: string,
  target: number,
) {
  const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
    where: { driverId },
    select: { creditAccount: { select: { id: true } } },
  });
  if (!profile.creditAccount)
    throw new Error(`independent driver ${driverId} has no credit account`);
  return moveTo(prisma, profile.creditAccount.id, target);
}

/**
 * Funds exactly what this Dispatch costs that actor (plus `extra` when a case needs a remainder),
 * so a claim or take succeeds for the reason the test is about and not because of a fat balance.
 * A legacy Dispatch has nothing to pay and is left alone.
 */
export async function fundForAward(
  prisma: PrismaClient,
  dispatchId: string,
  owner: { providerId: string } | { driverId: string },
  extra = 0,
) {
  const actorType =
    'providerId' in owner ? 'PROVIDER' : ('INDEPENDENT_DRIVER' as const);
  const snapshot = await prisma.dispatchCreditSnapshot.findUnique({
    where: { dispatchId_actorType: { dispatchId, actorType } },
    select: { credits: true },
  });
  const credits = (snapshot?.credits ?? 0) + extra;
  if (credits <= 0) return null;
  return 'providerId' in owner
    ? fundProvider(prisma, owner.providerId, credits)
    : fundIndependentDriver(prisma, owner.driverId, credits);
}

/**
 * Removes the ledger entries of the fixtures' accounts so a suite can delete its providers and
 * drivers afterwards: entries hold their account with a RESTRICT foreign key and the ledger is
 * append-only, so this uses the same purge switch the credits suite uses, which PostgreSQL only
 * honours in *_test databases. Balances go with their accounts (cascade with the owner).
 */
export async function purgeFixtureCredits(
  prisma: PrismaClient,
  owners: { providerIds?: string[]; driverIds?: string[] },
) {
  const accounts = await prisma.creditAccount.findMany({
    where: {
      OR: [
        { providerId: { in: owners.providerIds ?? [] } },
        {
          independentDriverProfile: {
            driverId: { in: owners.driverIds ?? [] },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (!accounts.length) return 0;
  const ids = accounts.map((a) => a.id);
  const [, refunds, deleted] = await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    // V1.10-E: a refund holds its award with a RESTRICT foreign key, so it goes first.
    prisma.creditLedgerEntry.deleteMany({
      where: { creditAccountId: { in: ids }, type: 'SERVICE_REFUND' },
    }),
    prisma.creditLedgerEntry.deleteMany({
      where: { creditAccountId: { in: ids } },
    }),
  ]);
  return refunds.count + deleted.count;
}

/** Current balance of a provider account, for assertions. */
export const providerBalance = async (
  prisma: PrismaClient,
  providerId: string,
) =>
  (await prisma.creditAccount.findUniqueOrThrow({ where: { providerId } }))
    .balance;

/** Current balance of an independent driver account, for assertions. */
export async function independentBalance(
  prisma: PrismaClient,
  driverId: string,
) {
  const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
    where: { driverId },
    select: { creditAccount: { select: { balance: true } } },
  });
  return profile.creditAccount?.balance ?? null;
}

/** Fixture teardown only: remove BOTH sides atomically using the existing *_test-only switch.
 * Normal DELETE is intentionally rejected by the award integrity constraints.
 */
export async function purgeFixtureDispatches(
  prisma: PrismaClient,
  clientIds: string[],
) {
  const rows = await prisma.dispatch.findMany({
    where: { deliveryRequest: { integrationClientId: { in: clientIds } } },
    select: { id: true },
  });
  const ids = rows.map((d) => d.id);
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    // V1.10-E: a refund holds its award with a RESTRICT foreign key, so it goes first.
    prisma.creditLedgerEntry.deleteMany({
      where: { type: 'SERVICE_REFUND', referenceId: { in: ids } },
    }),
    prisma.creditLedgerEntry.deleteMany({
      where: { type: 'SERVICE_AWARD', referenceId: { in: ids } },
    }),
    prisma.dispatchPreEnforcementAward.deleteMany({
      where: { dispatchId: { in: ids } },
    }),
    prisma.deliveryAssignment.deleteMany({
      where: { dispatchId: { in: ids } },
    }),
    prisma.dispatch.deleteMany({ where: { id: { in: ids } } }),
  ]);
}
