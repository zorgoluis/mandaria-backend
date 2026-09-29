import { describe, it, expect } from 'vitest';
import { Prisma, type DispatchStatus } from '@prisma/client';
import {
  collectionInstructionFields,
  collectionSourceSelect,
} from '../dist/delivery-assignments/collection-instructions.js';
type Source = Prisma.DispatchGetPayload<{
  select: typeof collectionSourceSelect;
}>;
const source = (status: DispatchStatus = 'CLAIMED'): Source => ({
  status,
  expiresAt: new Date('2100-01-01'),
  deliveryQuote: {
    status: 'ACCEPTED',
    amount: new Prisma.Decimal('25.10'),
    currency: 'MXN',
  },
  deliveryRequest: {
    status: 'CREATED',
    financialContext: { goodsPaymentMode: 'PREPAID' },
    prequoteConversion: {
      goodsPaymentStatus: 'CONFIRMED_BY_MERCHANT',
      collectionPayer: 'RECIPIENT',
      collectionMethod: 'CASH',
      collectionDueAt: 'DELIVERY',
      collectionComponent: 'DELIVERY_FEE',
      authorizedAcceptance: { authorizationVersion: 1 },
    },
  },
});
describe('D collection instructions', () => {
  it.each(['PREPAID', 'COURIER_ADVANCE'] as const)(
    'does not change legacy %s contracts',
    (mode) => {
      const d = source();
      d.deliveryRequest.prequoteConversion = null;
      d.deliveryRequest.financialContext!.goodsPaymentMode = mode;
      expect(collectionInstructionFields(d, 'EXECUTOR')).toEqual({});
    },
  );
  it.each(['CANCELLED', 'EXPIRED', 'DELIVERED'] as const)(
    '%s is historical, never a collection command',
    (status) => {
      expect(
        collectionInstructionFields(source(status), 'EXECUTOR')
          .collectionInstructions?.applicability,
      ).toBe('HISTORICAL');
    },
  );
  it('suppresses current action for a cancelled request, including late cancellation after delivery', () => {
    const d = source();
    d.deliveryRequest.status = 'CANCELLED';
    expect(
      collectionInstructionFields(d, 'EXECUTOR').collectionInstructions
        ?.applicability,
    ).toBe('HISTORICAL');
  });
  it('distinguishes an offer from current execution and ended assignment history', () => {
    expect(
      collectionInstructionFields(source('OPEN'), 'OFFER')
        .collectionInstructions?.applicability,
    ).toBe('OFFER');
    expect(
      collectionInstructionFields(source(), 'EXECUTOR').collectionInstructions
        ?.applicability,
    ).toBe('CURRENT');
    expect(
      collectionInstructionFields(source(), 'HISTORY').collectionInstructions
        ?.applicability,
    ).toBe('HISTORICAL');
  });
  it('expired OPEN offer cannot retain a current instruction', () => {
    const d = source('OPEN');
    d.expiresAt = new Date(0);
    expect(
      collectionInstructionFields(d, 'OFFER').collectionInstructions
        ?.applicability,
    ).toBe('HISTORICAL');
  });
  it('uses exact quote money and persisted instructions without exposing their source or mutating them', () => {
    const d = source();
    d.deliveryQuote.amount = new Prisma.Decimal('123456789012.34');
    const before = JSON.stringify(d);
    expect(
      collectionInstructionFields(d, 'EXECUTOR').collectionInstructions,
    ).toEqual({
      applicability: 'CURRENT',
      goodsPaidToRestaurant: true,
      advanceToRestaurant: false,
      collectGoodsFromRecipient: false,
      deliveryFee: { amount: '123456789012.34', currency: 'MXN' },
      payer: 'RECIPIENT',
      method: 'CASH',
      dueAt: 'DELIVERY',
      component: 'DELIVERY_FEE',
    });
    expect(JSON.stringify(d)).toBe(before);
  });
  it('does not fabricate instructions from an unauthorised or inconsistent conversion', () => {
    const d = source();
    d.deliveryRequest.prequoteConversion!.authorizedAcceptance = null;
    expect(collectionInstructionFields(d, 'EXECUTOR')).toEqual({});
    const other = source();
    other.deliveryRequest.prequoteConversion!.collectionMethod = 'CARD';
    expect(collectionInstructionFields(other, 'EXECUTOR')).toEqual({});
  });
});
