import { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { fingerprint } from '../idempotency/idempotency.service.js';
import { demandOwner, type DemandOwnerInput } from './demand-owner.js';

export type ShippingPayer = 'REQUESTER' | 'RECIPIENT';
export type PayerContact = {
  name: string;
  phone: string;
  capacity: 'REQUESTER' | 'AUTHORIZED_REPRESENTATIVE';
};
export type ShippingSnapshot = {
  payer: ShippingPayer;
  method: 'CASH';
  dueAt: 'PICKUP' | 'DELIVERY';
  component: 'DELIVERY_FEE';
  termsVersion: 1;
  policyRevision: number;
  termsHash: string;
};
export async function shippingSnapshot(
  tx: Prisma.TransactionClient,
  input: DemandOwnerInput,
  choice?: ShippingPayer,
): Promise<ShippingSnapshot> {
  const owner = demandOwner(input);
  let payer: ShippingPayer;
  let policyRevision: number;
  if (owner.kind === 'INTEGRATION') {
    if (choice)
      throw new DomainException(
        'SHIPPING_PAYER_NOT_ALLOWED',
        400,
        'Integration policy determines shipping payer',
      );
    await tx.$queryRaw`SELECT id FROM "IntegrationClient" WHERE id=${owner.id}::uuid FOR SHARE`;
    const client = await tx.integrationClient.findUniqueOrThrow({
      where: { id: owner.id },
    });
    if (
      client.defaultShippingPayer !== 'REQUESTER' &&
      client.defaultShippingPayer !== 'RECIPIENT'
    )
      throw new Error('Invalid shipping policy');
    payer = client.defaultShippingPayer;
    policyRevision = client.shippingPolicyRevision;
  } else {
    await tx.$queryRaw`SELECT id FROM "CustomerAccount" WHERE id=${owner.id}::uuid FOR SHARE`;
    const customer = await tx.customerAccount.findUniqueOrThrow({
      where: { id: owner.id },
    });
    payer = choice ?? 'REQUESTER';
    if (customer.type === 'PERSONAL' && payer !== 'REQUESTER')
      throw new DomainException(
        'SHIPPING_PAYER_NOT_ALLOWED',
        400,
        'Personal shipping is paid by requester',
      );
    policyRevision = customer.revision;
  }
  const terms = {
    payer,
    method: 'CASH' as const,
    dueAt: payer === 'REQUESTER' ? ('PICKUP' as const) : ('DELIVERY' as const),
    component: 'DELIVERY_FEE' as const,
    termsVersion: 1 as const,
    policyRevision,
  };
  return { ...terms, termsHash: fingerprint('shipping.terms', terms) };
}
export function readShippingSnapshot(
  value: Prisma.JsonValue | null,
): ShippingSnapshot | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid shipping snapshot');
  const {
    payer,
    method,
    dueAt,
    component,
    termsVersion,
    policyRevision,
    termsHash,
  } = value;
  if (
    (payer !== 'REQUESTER' && payer !== 'RECIPIENT') ||
    method !== 'CASH' ||
    dueAt !== (payer === 'REQUESTER' ? 'PICKUP' : 'DELIVERY') ||
    component !== 'DELIVERY_FEE' ||
    termsVersion !== 1 ||
    typeof policyRevision !== 'number' ||
    typeof termsHash !== 'string'
  )
    throw new Error('Invalid shipping snapshot');
  const terms = {
    payer,
    method,
    dueAt,
    component,
    termsVersion,
    policyRevision,
  } as const;
  if (fingerprint('shipping.terms', terms) !== termsHash)
    throw new Error('Invalid shipping snapshot hash');
  return { ...terms, termsHash };
}
