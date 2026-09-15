import type { Prisma } from '@prisma/client';

export const deliveryRequestSummarySelect = {
  id: true,
  publicId: true,
  integrationClientId: true,
  externalReference: true,
  status: true,
  requestedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  integrationClient: { select: { id: true, name: true, code: true } },
} as const;

export const deliveryRequestDetailSelect = {
  ...deliveryRequestSummarySelect,
  cancellationReason: true,
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
    // Deterministic order; packages have no business ordering in V1.5.
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
} as const;

type Summary = Prisma.DeliveryRequestGetPayload<{
  select: typeof deliveryRequestSummarySelect;
}>;
type Detail = Prisma.DeliveryRequestGetPayload<{
  select: typeof deliveryRequestDetailSelect;
}>;
const num = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toNumber();

export const toSummary = (row: Summary) => row;

/** Measurements become JSON numbers; money stays a 2-decimal string (never a float). */
export function toDetail(row: Detail) {
  const { financialContext, ...rest } = row;
  return {
    ...rest,
    stops: row.stops.map((s) => ({
      ...s,
      latitude: s.latitude.toNumber(),
      longitude: s.longitude.toNumber(),
    })),
    packages: row.packages.map((p) => ({
      ...p,
      weightKg: num(p.weightKg),
      lengthCm: num(p.lengthCm),
      widthCm: num(p.widthCm),
      heightCm: num(p.heightCm),
    })),
    financialContext: financialContext && {
      ...financialContext,
      goodsValue: financialContext.goodsValue?.toFixed(2) ?? null,
    },
  };
}

/** B2B contract: publicId is the identifier; internal IDs and client metadata are hidden. */
const HIDDEN_FOR_INTEGRATIONS = new Set([
  'id',
  'integrationClientId',
  'integrationClient',
]);
export function toIntegrationView<T extends Record<string, unknown>>(row: T) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !HIDDEN_FOR_INTEGRATIONS.has(key)),
  ) as Omit<T, 'id' | 'integrationClientId' | 'integrationClient'>;
}
