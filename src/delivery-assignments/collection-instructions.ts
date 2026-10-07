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
      shippingTerms: {
        select: {
          payer: true,
          method: true,
          dueAt: true,
          component: true,
          termsVersion: true,
          termsHash: true,
          declaration: { select: { recordedAt: true } },
        },
      },
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
): {
  collectionInstructions?: {
    applicability: string;
    goodsPaidToRestaurant: boolean;
    advanceToRestaurant: boolean;
    collectGoodsFromRecipient: boolean;
    deliveryFee: { amount: string; currency: string };
    payer: string;
    method: string;
    dueAt: string;
    component: string;
  };
  shippingPayment?: {
    payer: string;
    method: string;
    dueAt: string;
    component: string;
    termsVersion: number;
    termsHash: string;
    amount: string;
    currency: string;
    instructionStatus: string;
    evidenceStatus: string;
    declaredAt: string | null;
    collectShipping: boolean;
  };
} {
  const request = dispatch.deliveryRequest;
  const conversion = request.prequoteConversion;
  const terms = request.shippingTerms;
  const active =
    request.status === 'CREATED' &&
    ['OPEN', 'CLAIMED'].includes(effectiveDispatchStatus(dispatch, now));
  const shippingPayment = terms
    ? {
        payer: terms.payer,
        method: terms.method,
        dueAt: terms.dueAt,
        component: terms.component,
        termsVersion: terms.termsVersion,
        termsHash: terms.termsHash,
        amount: dispatch.deliveryQuote.amount.toFixed(2),
        currency: dispatch.deliveryQuote.currency,
        instructionStatus: active
          ? audience === 'OFFER'
            ? 'OFFER'
            : 'CURRENT'
          : 'HISTORICAL',
        evidenceStatus: terms.declaration ? 'DECLARED' : 'NOT_DECLARED',
        declaredAt: terms.declaration?.recordedAt.toISOString() ?? null,
        collectShipping: active && !terms.declaration,
      }
    : null;
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
    return shippingPayment ? { shippingPayment } : {};

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
    ...(shippingPayment ? { shippingPayment } : {}),
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
