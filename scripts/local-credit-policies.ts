// LOCAL/TEST ONLY: initial V1.10-B credit policies for development. The values are placeholders,
// NOT commercial decisions. Production policies are created by a SUPER_ADMIN through
// POST /api/v1/admin/credit-policies. Never wired into `prisma db seed`, the migration or Docker.
import type { PrismaClient } from '@prisma/client';
import { validatePolicyConfig } from '../src/credit-policies/credit-policy-engine.js';

export const LOCAL_CREDIT_POLICIES = [
  { serviceType: 'LOCAL_DELIVERY', actorType: 'PROVIDER' },
  { serviceType: 'LOCAL_DELIVERY', actorType: 'INDEPENDENT_DRIVER' },
].map((combination) => ({
  ...combination,
  calculationType: 'PER_KM',
  creditsPerKm: 1,
  minimumCredits: 3,
  reason: 'LOCAL/TEST ONLY: política inicial de desarrollo',
})) as {
  serviceType: 'LOCAL_DELIVERY';
  actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER';
  calculationType: 'PER_KM';
  creditsPerKm: number;
  minimumCredits: number;
  reason: string;
}[];

/**
 * Idempotent and never destructive: creates version 1 only for a combination that has never had a
 * policy. An existing policy (any version, any status) is left exactly as it is — changing
 * economics is always a new version made by a SUPER_ADMIN.
 */
export async function seedLocalCreditPolicies(
  prisma: PrismaClient,
  bootstrapAdminEmail: string | undefined,
) {
  if (!bootstrapAdminEmail)
    throw new Error(
      'Set BOOTSTRAP_ADMIN_EMAIL: policies are attributed to that SUPER_ADMIN',
    );
  const admin = await prisma.user.findUnique({
    where: { email: bootstrapAdminEmail.trim().toLowerCase() },
    select: { id: true, role: true },
  });
  if (!admin || admin.role !== 'SUPER_ADMIN')
    throw new Error(
      'Bootstrap SUPER_ADMIN not found; run npm run db:seed first',
    );
  const outcome: { combination: string; result: string }[] = [];
  for (const policy of LOCAL_CREDIT_POLICIES) {
    const check = validatePolicyConfig(policy);
    if (!check.valid)
      throw new Error(`Invalid local policy: ${check.errors.join('; ')}`);
    const combination = `${policy.serviceType}/${policy.actorType}`;
    const result = await prisma.$transaction(async (tx) => {
      // Same lock as the admin API, so the seed never races a SUPER_ADMIN creating a version.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(71600020::int, hashtext(${combination.replace('/', ':')}))`;
      const existing = await tx.creditPolicy.findFirst({
        where: { serviceType: policy.serviceType, actorType: policy.actorType },
        orderBy: { version: 'desc' },
        select: { version: true, status: true },
      });
      if (existing)
        return `kept existing v${existing.version} (${existing.status})`;
      const created = await tx.creditPolicy.create({
        data: {
          serviceType: policy.serviceType,
          actorType: policy.actorType,
          version: 1,
          status: 'ACTIVE',
          calculationType: policy.calculationType,
          creditsPerKm: policy.creditsPerKm,
          minimumCredits: policy.minimumCredits,
          effectiveFrom: new Date(),
          reason: policy.reason,
          createdByUserId: admin.id,
        },
        select: { id: true, version: true },
      });
      return `created v${created.version} ${created.id}`;
    });
    outcome.push({ combination, result });
  }
  return outcome;
}
