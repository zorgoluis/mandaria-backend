import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { verificationError } from './verification-error.js';

/** Called under the existing resource locks. SQL also enforces admission for old writers. */
export async function assertDocumentaryEligibility(
  tx: Prisma.TransactionClient,
  driverId: string,
  vehicleId: string,
) {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'development'
  ) {
    await tx.$executeRaw`SELECT set_config('mandaria.verification_environment', 'LOCAL_TEST', true)`;
  }
  const [result] = await tx.$queryRaw<
    { code: string | null }[]
  >`SELECT verification_eligibility(${driverId}::uuid, ${vehicleId}::uuid) AS code`;
  if (result.code) verificationError(result.code);
}
@Injectable()
export class VerificationRuntime {
  constructor(private readonly config: ConfigService) {}
  assertLocal() {
    if (
      !this.config.get<boolean>('DRIVER_VERIFICATION_LOCAL_ENABLED') ||
      this.config.get<string>('NODE_ENV') === 'production'
    )
      verificationError('VERIFICATION_LOCAL_DISABLED', 503);
  }
}
// Driver self contains only effective status, never documents, legal identity fields or file keys.
export async function documentaryDriverView(
  db: import('../prisma/prisma.service.js').PrismaService,
  driver: { id: string; name: string; provider: { id: string } | null },
  profileId?: string,
) {
  const policy = await db.verificationPolicy.findUniqueOrThrow({
    where: { id: 1 },
  });
  if (!policy.enabled && driver.provider) return null;
  const subject = await db.verificationSubject.findFirst({
    where: {
      driverId: driver.id,
      ...(profileId
        ? { providerId: null, independentProfileId: profileId }
        : { providerId: driver.provider?.id ?? null }),
    },
  });
  const approved = subject
    ? await db.verificationCase.findFirst({
        where: { subjectId: subject.id, status: 'APPROVED' },
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      })
    : null;
  let status = 'REVIEW_REQUIRED';
  if (approved)
    status =
      JSON.stringify(approved.materialSnapshot) ===
      JSON.stringify({ name: driver.name })
        ? 'APPROVED'
        : 'REVALIDATION_REQUIRED';
  if (approved?.validUntil && approved.validUntil <= new Date())
    status = 'EXPIRED';
  const local =
    process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  return {
    identityStatus: status,
    policyVersion: 'LOCAL-TEST-1',
    environment: 'LOCAL_TEST',
    canAdmitIdentity: status === 'APPROVED' && local,
    blockingReasons:
      status === 'APPROVED'
        ? local
          ? []
          : ['VERIFICATION_TEST_RECEIPT_NOT_OPERATIONAL']
        : ['VERIFICATION_' + status],
  };
}
