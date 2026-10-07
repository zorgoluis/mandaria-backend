import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import {
  demandOwner,
  type DemandOwnerInput,
} from '../customers/demand-owner.js';

export const attemptError = (code: string) =>
  new DomainException(code, 409, 'Command attempt cannot be reused');
export const CREATE_MPQ = 'delivery_prequotes.create';
export const CONVERT_MPQ = 'delivery_prequotes.convert';
export const ACCEPT_MQ = 'delivery_quotes.accept_authorized';
export const SHIPPING_POLICY = 'shipping.policy';
export type HumanAttemptScope = {
  namespace: 'CUSTOMER' | 'POLICY';
  ownerId: string;
  actorUserId: string;
  key: string;
  operation: string;
  resource: string;
};
export function validateAttemptKey(key: string) {
  if (typeof key !== 'string' || !/^[!-~]{8,255}$/.test(key))
    throw new DomainException(
      'IDEMPOTENCY_KEY_INVALID',
      400,
      'Invalid Idempotency-Key',
    );
}
export async function lockHumanAttempt(
  tx: Prisma.TransactionClient,
  s: HumanAttemptScope,
  allowClosed = false,
) {
  validateAttemptKey(s.key);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${s.namespace + ':' + s.ownerId + ':' + s.key},1717))::text`;
  await tx.humanCommandAttempt.createMany({ data: s, skipDuplicates: true });
  const row = await tx.humanCommandAttempt.findUniqueOrThrow({
    where: {
      namespace_ownerId_key: {
        namespace: s.namespace,
        ownerId: s.ownerId,
        key: s.key,
      },
    },
  });
  if (
    row.actorUserId !== s.actorUserId ||
    row.operation !== s.operation ||
    row.resource !== s.resource
  )
    throw attemptError('COMMAND_ATTEMPT_SCOPE_CONFLICT');
  if (row.closedAt && !allowClosed)
    throw attemptError('COMMAND_ATTEMPT_CLOSED');
  return row;
}
/** Shared lock order: CustomerAccount -> attempt fence -> receipt -> resources. */
export async function customerAttempt(
  tx: Prisma.TransactionClient,
  owner: DemandOwnerInput,
  key: string,
  operation: string,
  resource = '',
  allowClosed = false,
) {
  const o = demandOwner(owner);
  if (o.kind !== 'CUSTOMER') return null;
  await tx.$queryRaw`SELECT id FROM "CustomerAccount" WHERE id=${o.id}::uuid FOR UPDATE`;
  const c = await tx.customerAccount.findUniqueOrThrow({
    where: { id: o.id },
    select: { userId: true },
  });
  return lockHumanAttempt(
    tx,
    {
      namespace: 'CUSTOMER',
      ownerId: o.id,
      actorUserId: c.userId,
      key,
      operation,
      resource,
    },
    allowClosed,
  );
}
