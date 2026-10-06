import { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';

export type DemandOwner =
  { kind: 'INTEGRATION'; id: string } | { kind: 'CUSTOMER'; id: string };
/** String input preserves the existing internal B2B callers, never implies a human owner. */
export type DemandOwnerInput = string | DemandOwner;
export const demandOwner = (value: DemandOwnerInput): DemandOwner =>
  typeof value === 'string' ? { kind: 'INTEGRATION', id: value } : value;
export function ownerFields(value: DemandOwnerInput) {
  const o = demandOwner(value);
  return o.kind === 'INTEGRATION'
    ? { integrationClientId: o.id, customerAccountId: null }
    : { integrationClientId: null, customerAccountId: o.id };
}
export function ownerKey(value: DemandOwnerInput, key: string) {
  const o = demandOwner(value);
  return o.kind === 'INTEGRATION'
    ? { integrationClientId_key: { integrationClientId: o.id, key } }
    : { customerAccountId_key: { customerAccountId: o.id, key } };
}
export function ownerSql(value: DemandOwnerInput) {
  const o = demandOwner(value);
  return o.kind === 'INTEGRATION'
    ? Prisma.sql`"integrationClientId"=${o.id}::uuid AND "customerAccountId" IS NULL`
    : Prisma.sql`"customerAccountId"=${o.id}::uuid AND "integrationClientId" IS NULL`;
}
export function rowOwner(row: {
  integrationClientId: string | null;
  customerAccountId: string | null;
}): DemandOwner {
  if (row.integrationClientId && !row.customerAccountId)
    return { kind: 'INTEGRATION', id: row.integrationClientId };
  if (row.customerAccountId && !row.integrationClientId)
    return { kind: 'CUSTOMER', id: row.customerAccountId };
  throw new DomainException(
    'DEMAND_OWNER_INVALID',
    503,
    'Demand owner unavailable',
  );
}
export async function lockCustomer(
  tx: Prisma.TransactionClient,
  owner: DemandOwnerInput,
) {
  const o = demandOwner(owner);
  if (o.kind !== 'CUSTOMER') return;
  await tx.$queryRaw`SELECT id FROM "CustomerAccount" WHERE id=${o.id}::uuid FOR UPDATE`;
  const c = await tx.customerAccount.findUnique({
    where: { id: o.id },
    include: { user: true },
  });
  if (!c?.active || !c.user.active || !c.user.emailVerifiedAt)
    throw new DomainException(
      'CUSTOMER_ACCESS_DENIED',
      403,
      'Customer unavailable',
    );
  return c;
}
/** Parent lock before MDR/Dispatch everywhere, including administrative and operational closures. */
export async function lockRequestCustomer(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  const r = await tx.deliveryRequest.findUnique({
    where: { id: requestId },
    select: { customerAccountId: true },
  });
  if (r?.customerAccountId)
    await tx.$queryRaw`SELECT id FROM "CustomerAccount" WHERE id=${r.customerAccountId}::uuid FOR UPDATE`;
}
