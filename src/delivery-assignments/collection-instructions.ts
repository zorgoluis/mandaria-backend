import type { Prisma } from '@prisma/client';
import { effectiveDispatchStatus } from '../dispatch/dispatch-policy.js';

// Explicit allowlist: never read merchant references, consent or credential evidence.
export const collectionConversionSelect = {
  goodsPaymentStatus: true,
  collectionPayer: true,
  collectionMethod: true,
  collectionDueAt: true,
  collectionComponent: true,
  authorizedAcceptance: { select: { authorizationVersion: true } },
} satisfies Prisma.PrequoteConversionSelect;

export const collectionSourceSelect = {
  status: true,
  expiresAt: true,
  deliveryQuote: { select: { status: true, amount: true, currency: true } },
  deliveryRequest: {
    select: {
      status: true,
      financialContext: { select: { goodsPaymentMode: true } },
      prequoteConversion: { select: collectionConversionSelect },
    },
  },
} satisfies Prisma.DispatchSelect;
type Source = Prisma.DispatchGetPayload<{
  select: typeof collectionSourceSelect;
}>;

/** Read-only instructions, never a receipt, payment state or a second editable price. */
export function collectionInstructionFields(
  dispatch: Source,
  audience: 'OFFER' | 'EXECUTOR' | 'HISTORY',
  now = new Date(),
) {
  const request = dispatch.deliveryRequest;
  const conversion = request.prequoteConversion;
  if (
    !conversion?.authorizedAcceptance ||
    dispatch.deliveryQuote.status !== 'ACCEPTED' ||
    request.financialContext?.goodsPaymentMode !== 'PREPAID' ||
    conversion.goodsPaymentStatus !== 'CONFIRMED_BY_MERCHANT' ||
    conversion.collectionPayer !== 'RECIPIENT' ||
    conversion.collectionMethod !== 'CASH' ||
    conversion.collectionDueAt !== 'DELIVERY' ||
    conversion.collectionComponent !== 'DELIVERY_FEE'
  )
    return {};

  const status = effectiveDispatchStatus(dispatch, now);
  const applicability =
    request.status === 'CREATED' &&
    status === 'CLAIMED' &&
    audience === 'EXECUTOR'
      ? 'CURRENT'
      : request.status === 'CREATED' &&
          status === 'OPEN' &&
          audience === 'OFFER'
        ? 'OFFER'
        : 'HISTORICAL';
  return {
    collectionInstructions: {
      applicability,
      goodsPaidToRestaurant: true,
      advanceToRestaurant: false,
      collectGoodsFromRecipient: false,
      deliveryFee: {
        amount: dispatch.deliveryQuote.amount.toFixed(2),
        currency: dispatch.deliveryQuote.currency,
      },
      payer: conversion.collectionPayer,
      method: conversion.collectionMethod,
      dueAt: conversion.collectionDueAt,
      component: conversion.collectionComponent,
    },
  };
}
