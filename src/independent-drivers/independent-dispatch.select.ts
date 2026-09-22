import {
  creditEnforcementMode,
  preEnforcementSelect,
} from '../credits/award-boundary.js';
import type { Prisma } from '@prisma/client';
import { effectiveDispatchStatus } from '../dispatch/dispatch-policy.js';
import { paymentContext } from '../delivery-assignments/assignment-policy.js';
import { creditCostFor } from '../credit-policies/dispatch-credit-snapshots.js';

const decimal = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toFixed(2);
const coordinate = (value: Prisma.Decimal) => value.toNumber();

/**
 * What the driver endpoints read. Deliberately narrower than dispatchSelect: DispatchCandidate,
 * claimedByProviderId and the IntegrationClient identity are not selected at all, so a provider's
 * commercial relationships cannot leak into a driver response by accident (§18).
 */
export const driverDispatchSelect = {
  id: true,
  creditMode: true,
  preEnforcementAwards: {
    where: { actorType: 'INDEPENDENT_DRIVER' },
    select: preEnforcementSelect,
  },
  status: true,
  openedAt: true,
  expiresAt: true,
  claimedByIndependentDriverId: true,
  claimedAt: true,
  cancelledAt: true,
  deliveryQuote: {
    select: {
      serviceType: true,
      distanceMeters: true,
      durationSeconds: true,
      amount: true,
      currency: true,
      serviceZone: { select: { code: true, name: true } },
    },
  },
  deliveryRequest: {
    select: {
      publicId: true,
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
      driverId: true,
      vehicle: {
        select: { id: true, identifier: true, type: true, plate: true },
      },
    },
  },
  // V1.10-C: only the independent-driver cost is read; the provider one never reaches this query.
  creditSnapshots: {
    where: { actorType: 'INDEPENDENT_DRIVER' },
    select: { actorType: true, credits: true },
  },
} satisfies Prisma.DispatchSelect;
export type DriverDispatchRecord = Prisma.DispatchGetPayload<{
  select: typeof driverDispatchSelect;
}>;

/**
 * Two access levels, mirroring V1.7 for providers:
 * - OFFER: everything needed to decide whether to take the service — route, addresses and
 *   coordinates, packages without free text, the delivery fee and how much the driver would have
 *   to advance for the goods. No contact data, no delivery instructions, no merchant reference.
 * - OWNER: the driver took it and is going to execute it, so contacts, instructions, package
 *   descriptions and the public request id are added.
 * A driver never sees providers, candidates, the IntegrationClient or administrative fields.
 */
export function driverDispatchView(
  dispatch: DriverDispatchRecord,
  driverId: string,
  now = new Date(),
) {
  const status = effectiveDispatchStatus(dispatch, now);
  const owner = dispatch.claimedByIndependentDriverId === driverId;
  const access: 'OWNER' | 'OFFER' = owner ? 'OWNER' : 'OFFER';
  const quote = dispatch.deliveryQuote;
  const request = dispatch.deliveryRequest;
  const assignment = dispatch.deliveryAssignments[0] ?? null;
  const stop = (type: 'PICKUP' | 'DROPOFF') => {
    const s = request.stops.find((x) => x.type === type)!;
    return {
      address: s.address,
      latitude: coordinate(s.latitude),
      longitude: coordinate(s.longitude),
      ...(owner
        ? {
            contactName: s.contactName,
            contactPhone: s.contactPhone,
            instructions: s.instructions,
          }
        : {}),
    };
  };
  return {
    id: dispatch.id,
    status,
    access,
    serviceType: quote.serviceType,
    serviceZone: quote.serviceZone,
    openedAt: dispatch.openedAt,
    expiresAt: dispatch.expiresAt,
    takenByMe: owner,
    claimedAt: owner ? dispatch.claimedAt : null,
    cancelledAt: dispatch.cancelledAt,
    // V1.10-C: what taking this dispatch costs me, frozen when it opened. Credits, not money.
    // null = opened before V1.10-C (legacy).
    creditEnforcementMode: creditEnforcementMode(
      dispatch,
      'INDEPENDENT_DRIVER',
      dispatch.claimedByIndependentDriverId,
    ),
    creditCost: creditCostFor(dispatch.creditSnapshots, 'INDEPENDENT_DRIVER'),
    // Only ever my own assignment: a driver never learns who else is executing a service.
    assignment:
      owner && assignment?.driverId === driverId
        ? {
            id: assignment.id,
            mode: assignment.mode,
            assignedAt: assignment.assignedAt,
            vehicle: assignment.vehicle,
          }
        : null,
    service: {
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
        ...(owner
          ? {
              description: p.description,
              handlingInstructions: p.handlingInstructions,
            }
          : {}),
      })),
      ...(owner ? { deliveryRequestPublicId: request.publicId } : {}),
    },
    // V1.8 money shape, reused verbatim: what the driver earns and what it must advance (§41).
    paymentContext: paymentContext(quote, request.financialContext),
    goods: request.financialContext
      ? {
          paymentMode: request.financialContext.goodsPaymentMode,
          value: decimal(request.financialContext.goodsValue),
          currency: request.financialContext.currency,
        }
      : null,
  };
}
