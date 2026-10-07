import type { Prisma } from '@prisma/client';

/** No payer identity, Driver identity or receipt key in public tracking. */
export async function shippingView(
  tx: Prisma.TransactionClient,
  requestId: string,
  terminal: boolean,
  includeContact = false,
) {
  const terms = await tx.deliveryShippingTerms.findUnique({
    where: { deliveryRequestId: requestId },
    include: { declaration: true },
  });
  if (!terms) return null;
  const quote = await tx.deliveryQuote.findFirst({
    where: { deliveryRequestId: requestId, status: 'ACCEPTED' },
    select: { publicId: true, amount: true, currency: true },
  });
  return {
    payer: terms.payer,
    method: terms.method,
    dueAt: terms.dueAt,
    component: terms.component,
    termsVersion: terms.termsVersion,
    termsHash: terms.termsHash,
    amount: quote?.amount.toFixed(2) ?? null,
    currency: quote?.currency ?? null,
    quotePublicId: quote?.publicId ?? null,
    instructionStatus: terminal ? 'HISTORICAL' : 'CURRENT',
    evidenceStatus: terms.declaration ? 'DECLARED' : 'NOT_DECLARED',
    declaredAt: terms.declaration?.recordedAt.toISOString() ?? null,
    collectShipping: !!quote && !terminal && !terms.declaration,
    ...(includeContact ? { payerContact: terms.payerContact } : {}),
  };
}
