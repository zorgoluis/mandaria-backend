import type { CreditFixtureClient } from './credit-client.js';

/**
 * V1.10-C: opening a Dispatch (accepting a quote) requires an ACTIVE credit policy for every actor
 * that may execute the service, and fails closed without one. Credit policies are global
 * configuration, so every E2E file that accepts quotes calls this first: it guarantees an ACTIVE
 * baseline policy (PER_KM, 1 credit/km, minimum 3) per actor of LOCAL_DELIVERY, creating the next
 * version only where none is ACTIVE. It never edits or replaces an existing policy.
 *
 * The author is a dedicated, never-activated SUPER_ADMIN (INVITED: no password, cannot log in) that
 * suites do not delete, so their own cleanup never trips over the policy's author foreign key.
 * Only for disposable *_test databases.
 */
export const BASELINE_POLICY_AUTHOR =
  'credit-policy-baseline@mandaria-e2e.test';

export async function ensureTestCreditPolicies(prisma: CreditFixtureClient) {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>(
    'SELECT current_database() AS db',
  );
  if (!db.endsWith('_test'))
    throw new Error('ensureTestCreditPolicies only runs on *_test databases');
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
  for (const actorType of ['PROVIDER', 'INDEPENDENT_DRIVER'] as const)
    await prisma.$transaction(async (tx) => {
      // Same lock as the admin API, so this never races a concurrent version.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(71600020::int, hashtext(${`LOCAL_DELIVERY:${actorType}`}))`;
      const active = await tx.creditPolicy.findFirst({
        where: { serviceType: 'LOCAL_DELIVERY', actorType, status: 'ACTIVE' },
        select: { id: true },
      });
      if (active) return;
      const latest = await tx.creditPolicy.findFirst({
        where: { serviceType: 'LOCAL_DELIVERY', actorType },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.creditPolicy.create({
        data: {
          serviceType: 'LOCAL_DELIVERY',
          actorType,
          version: (latest?.version ?? 0) + 1,
          calculationType: 'PER_KM',
          creditsPerKm: 1,
          minimumCredits: 3,
          effectiveFrom: new Date(),
          reason: 'E2E baseline policy',
          createdByUserId: author.id,
        },
      });
    });
}
