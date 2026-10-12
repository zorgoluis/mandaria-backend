import { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
export async function assertBusinessAdmission(
  tx: Prisma.TransactionClient,
  accountId: string,
) {
  const c = await tx.customerAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  if (c.type === 'PERSONAL') return;
  if (c.businessAccessState !== 'ACTIVE')
    throw new DomainException(
      c.businessAccessState === 'REVIEW_REQUIRED'
        ? 'BUSINESS_REVIEW_REQUIRED'
        : 'BUSINESS_ACCESS_RESTRICTED',
      409,
      'Business approval required',
    );
  const grant = await tx.businessAccessGrant.findFirst({
    where: { customerAccountId: accountId, status: 'ACTIVE' },
  });
  if (!grant)
    throw new DomainException(
      'BUSINESS_ACCESS_RESTRICTED',
      409,
      'Business approval required',
    );
  return grant;
}
export async function businessProjection(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const c = await tx.customerAccount.findUniqueOrThrow({
    where: { id },
    include: { user: true },
  });
  const pending = await tx.businessApplication.findFirst({
    where: { customerAccountId: id, status: 'PENDING' },
  });
  const app =
    pending ??
    (await tx.businessApplication.findFirst({
      where: { customerAccountId: id },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    }));
  const grant = await tx.businessAccessGrant.findFirst({
    where: { customerAccountId: id, status: 'ACTIVE' },
  });
  const hasHistory = await tx.businessAccessEvent.findFirst({
    where: { customerAccountId: id, operation: 'LEGACY_REVIEW' },
  });
  const revoked = await tx.businessAccessGrant.findFirst({
    where: { customerAccountId: id, revocationCause: 'ADMIN_REVOCATION' },
    orderBy: [{ revokedAt: 'desc' }, { id: 'desc' }],
  });
  const open = await tx.directRequestLifecycle.count({
    where: { customerAccountId: id, closedAt: null },
  });
  return {
    customerAccountId: id,
    businessAccess: {
      state: c.businessAccessState,
      source:
        grant || revoked ? 'MANUAL_ADMIN' : hasHistory ? 'LEGACY_REVIEW' : null,
      restrictionReason:
        c.businessAccessState === 'REVIEW_REQUIRED'
          ? 'REVIEW_REQUIRED'
          : c.businessAccessState === 'RESTRICTED'
            ? revoked
              ? 'REVOKED'
              : 'REJECTED'
            : null,
      canApply: !!(
        c.active &&
        c.user.active &&
        c.user.emailVerifiedAt &&
        !grant &&
        !pending &&
        !c.businessReapplicationBlockedByGrantId
      ),
      canDowngrade: c.type === 'BUSINESS' && open === 0,
      reapplicationBlocked: c.businessReapplicationBlockedByGrantId !== null,
    },
    businessApplication: app
      ? { id: app.id, status: app.status, revision: app.revision }
      : null,
  };
}
