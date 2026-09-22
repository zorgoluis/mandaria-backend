import type { DispatchCandidateStatus, Prisma } from '@prisma/client';
import { allowsIndependent } from '../independent-drivers/independent-driver-policy.js';
import { effectiveDispatchStatus } from './dispatch-policy.js';
import {
  creditCostFor,
  dispatchCreditSnapshotSelect,
} from '../credit-policies/dispatch-credit-snapshots.js';

const decimal = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toFixed(2);
const coordinate = (value: Prisma.Decimal) => value.toNumber();

export const dispatchSelect = {
  id: true,
  status: true,
  openedAt: true,
  expiresAt: true,
  claimedByProviderId: true,
  claimedByIndependentDriverId: true,
  claimedAt: true,
  expiredAt: true,
  cancelledAt: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  deliveryQuote: {
    select: {
      publicId: true,
      serviceType: true,
      distanceMeters: true,
      durationSeconds: true,
      amount: true,
      currency: true,
      serviceZone: { select: { id: true, code: true, name: true } },
    },
  },
  deliveryRequest: {
    select: {
      publicId: true,
      externalReference: true,
      status: true,
      integrationClientId: true,
      stops: {
        orderBy: { sequence: 'asc' },
        select: {
          type: true,
          sequence: true,
          address: true,
          latitude: true,
          longitude: true,
          contactName: true,
          contactPhone: true,
          instructions: true,
        },
      },
      packages: {
        orderBy: { id: 'asc' },
        select: {
          category: true,
          description: true,
          quantity: true,
          weightKg: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
          isFragile: true,
          handlingInstructions: true,
        },
      },
      financialContext: {
        select: { goodsValue: true, goodsPaymentMode: true, currency: true },
      },
    },
  },
  deliveryAssignments: {
    where: { status: 'ACTIVE' },
    take: 1,
    select: {
      id: true,
      mode: true,
      assignedAt: true,
      assignedByUserId: true,
      driver: { select: { id: true, name: true } },
      vehicle: {
        select: { id: true, identifier: true, type: true, plate: true },
      },
    },
  },
  candidates: {
    orderBy: [{ offeredAt: 'asc' }, { providerId: 'asc' }],
    select: {
      providerId: true,
      status: true,
      offeredAt: true,
      claimedAt: true,
      releasedAt: true,
      releaseReason: true,
      provider: { select: { id: true, name: true, code: true } },
    },
  },
  // V1.10-C: frozen credit cost per actor; each view exposes only what its audience may see.
  creditSnapshots: {
    orderBy: { actorType: 'asc' },
    select: dispatchCreditSnapshotSelect,
  },
} satisfies Prisma.DispatchSelect;
export type DispatchRecord = Prisma.DispatchGetPayload<{
  select: typeof dispatchSelect;
}>;

/**
 * What a provider may see depends on its relation to the dispatch:
 * - OWNER (claim holder, CLAIMED or cancelled after its claim): full operational detail,
 *   including contacts, instructions and the merchant's order reference;
 * - OFFER (OPEN, in window, own candidate still OFFERED): what is needed to decide a claim —
 *   route, addresses and coordinates, packages without free text, delivery fee and whether the
 *   driver must advance the goods value; no contacts, instructions or references;
 * - SUMMARY (any other case, e.g. claimed by another provider, expired or released by me):
 *   status and times only.
 * IntegrationClient identity and other candidates are never exposed to providers.
 */
export function providerDispatchView(
  dispatch: DispatchRecord,
  providerId: string,
  now = new Date(),
  deadline: {
    assignmentDeadline: Date | null;
    assignmentOverdue: boolean;
  } = { assignmentDeadline: null, assignmentOverdue: false },
) {
  const status = effectiveDispatchStatus(dispatch, now);
  const mine = dispatch.candidates.find((c) => c.providerId === providerId);
  const owner = dispatch.claimedByProviderId === providerId;
  const access: 'OWNER' | 'OFFER' | 'SUMMARY' =
    owner && (status === 'CLAIMED' || status === 'CANCELLED')
      ? 'OWNER'
      : status === 'OPEN' && mine?.status === 'OFFERED'
        ? 'OFFER'
        : 'SUMMARY';
  const quote = dispatch.deliveryQuote;
  const request = dispatch.deliveryRequest;
  const base = {
    id: dispatch.id,
    status,
    access,
    serviceType: quote.serviceType,
    serviceZone: { code: quote.serviceZone.code, name: quote.serviceZone.name },
    openedAt: dispatch.openedAt,
    expiresAt: dispatch.expiresAt,
    claimedByMe: owner,
    claimedAt: owner ? dispatch.claimedAt : null,
    cancelledAt: dispatch.cancelledAt,
    // V1.10-C: what claiming this dispatch costs a provider, frozen when it opened. Credits, not
    // money (never part of service.deliveryFee or goods). null = opened before V1.10-C (legacy).
    creditCost: creditCostFor(dispatch.creditSnapshots, 'PROVIDER'),
    // V1.8: who executes the service; only the claim owner sees it.
    assignment: owner ? (dispatch.deliveryAssignments[0] ?? null) : null,
    ...deadline,
    myCandidate: mine
      ? {
          status: mine.status as DispatchCandidateStatus,
          offeredAt: mine.offeredAt,
          claimedAt: mine.claimedAt,
          releasedAt: mine.releasedAt,
          releaseReason: mine.releaseReason,
        }
      : null,
  };
  if (access === 'SUMMARY') return { ...base, service: null };
  const stop = (type: 'PICKUP' | 'DROPOFF') => {
    const s = request.stops.find((x) => x.type === type)!;
    return {
      address: s.address,
      latitude: coordinate(s.latitude),
      longitude: coordinate(s.longitude),
      ...(access === 'OWNER'
        ? {
            contactName: s.contactName,
            contactPhone: s.contactPhone,
            instructions: s.instructions,
          }
        : {}),
    };
  };
  return {
    ...base,
    service: {
      deliveryFee: {
        amount: quote.amount.toFixed(2),
        currency: quote.currency,
      },
      route: {
        distanceMeters: quote.distanceMeters,
        durationSeconds: quote.durationSeconds,
      },
      pickup: stop('PICKUP'),
      dropoff: stop('DROPOFF'),
      packages: request.packages.map((p) => ({
        category: p.category,
        quantity: p.quantity,
        weightKg: p.weightKg === null ? null : p.weightKg.toNumber(),
        isFragile: p.isFragile,
        ...(access === 'OWNER'
          ? {
              description: p.description,
              lengthCm: p.lengthCm === null ? null : p.lengthCm.toNumber(),
              widthCm: p.widthCm === null ? null : p.widthCm.toNumber(),
              heightCm: p.heightCm === null ? null : p.heightCm.toNumber(),
              handlingInstructions: p.handlingInstructions,
            }
          : {}),
      })),
      goods: goodsView(request.financialContext),
      ...(access === 'OWNER'
        ? {
            deliveryRequestPublicId: request.publicId,
            externalReference: request.externalReference,
          }
        : {}),
    },
  };
}

/** Goods context kept for operations: COURIER_ADVANCE means the driver pays at pickup. */
function goodsView(
  financial: DispatchRecord['deliveryRequest']['financialContext'],
) {
  return financial
    ? {
        paymentMode: financial.goodsPaymentMode,
        value: decimal(financial.goodsValue),
        currency: financial.currency,
        driverAdvancesGoods: financial.goodsPaymentMode === 'COURIER_ADVANCE',
        // Money the driver must advance to the merchant at pickup (never moved by Mandaria).
        driverAdvanceAmount:
          financial.goodsPaymentMode === 'COURIER_ADVANCE'
            ? decimal(financial.goodsValue)
            : null,
      }
    : null;
}

/** SUPER_ADMIN audit view: full dispatch, every candidate and the derived no-provider flag. */
export function adminDispatchView(dispatch: DispatchRecord, now = new Date()) {
  const status = effectiveDispatchStatus(dispatch, now);
  return {
    id: dispatch.id,
    status,
    openedAt: dispatch.openedAt,
    expiresAt: dispatch.expiresAt,
    claimedByProviderId: dispatch.claimedByProviderId,
    // V1.9: the other execution model. Exactly one of the two is set while CLAIMED.
    claimedByIndependentDriverId: dispatch.claimedByIndependentDriverId,
    claimMode: dispatch.claimedByIndependentDriverId
      ? 'INDEPENDENT'
      : dispatch.claimedByProviderId
        ? 'FLEET'
        : null,
    claimedAt: dispatch.claimedAt,
    expiredAt: dispatch.expiredAt,
    cancelledAt: dispatch.cancelledAt,
    cancellationReason: dispatch.cancellationReason,
    createdAt: dispatch.createdAt,
    updatedAt: dispatch.updatedAt,
    deliveryRequest: {
      publicId: dispatch.deliveryRequest.publicId,
      status: dispatch.deliveryRequest.status,
      integrationClientId: dispatch.deliveryRequest.integrationClientId,
    },
    deliveryQuote: {
      publicId: dispatch.deliveryQuote.publicId,
      serviceType: dispatch.deliveryQuote.serviceType,
      serviceZone: dispatch.deliveryQuote.serviceZone,
      amount: dispatch.deliveryQuote.amount.toFixed(2),
      currency: dispatch.deliveryQuote.currency,
    },
    activeAssignment: dispatch.deliveryAssignments[0] ?? null,
    // Derived signal instead of a status: no provider can currently claim this OPEN dispatch.
    // V1.9 keeps its V1.7 meaning (providers only) so existing consumers do not change; whether
    // the other execution model could still take it is reported separately.
    noProviderAvailable:
      status === 'OPEN' &&
      !dispatch.candidates.some((c) => c.status === 'OFFERED'),
    openToIndependentDrivers:
      status === 'OPEN' &&
      allowsIndependent(dispatch.deliveryQuote.serviceType),
    candidates: dispatch.candidates.map((c) => ({
      provider: c.provider,
      status: c.status,
      offeredAt: c.offeredAt,
      claimedAt: c.claimedAt,
      releasedAt: c.releasedAt,
      releaseReason: c.releaseReason,
    })),
    goods: goodsView(dispatch.deliveryRequest.financialContext),
    // V1.10-C audit: every frozen cost with the policy version and evidence that produced it.
    creditSnapshots: dispatch.creditSnapshots,
    legacyWithoutCreditSnapshots: dispatch.creditSnapshots.length === 0,
  };
}
