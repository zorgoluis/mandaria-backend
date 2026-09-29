import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
/** Defense shared by legacy quote/accept and dispatch opening; SQL is the final authority. */
export async function rejectConvertedRequest(
  tx: Prisma.TransactionClient,
  deliveryRequestId: string,
  code = 'AUTHORIZED_ACCEPT_REQUIRED',
) {
  if (
    await tx.prequoteConversion.findUnique({
      where: { deliveryRequestId },
      select: { id: true },
    })
  )
    throw new DomainException(
      code,
      409,
      'Converted prequote requires a future authorized acceptance flow',
    );
}
