// LOCAL/TEST ONLY: service zones and an initial LOCAL_DELIVERY rate plan for development.
// Boundaries are rough rectangles around Ocozocoautla and Tuxtla Gutiérrez (Chiapas, México) and the
// prices are placeholders, NOT commercial values. Production zones and tariffs must be created by a
// SUPER_ADMIN through the admin API. Never wired into `prisma db seed` or the Docker entrypoint.
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  boundariesIntersect,
  boundingBox,
  parseBoundary,
} from '../src/geo/geometry.js';
import { validateBands } from '../src/rate-plans/rate-bands.js';

const rectangle = (
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ] as [number, number][],
  ],
});

export const LOCAL_PRICING = {
  zones: {
    ocozocoautla: {
      code: 'LOCAL_OCOZOCOAUTLA',
      name: 'Ocozocoautla de Espinosa, Chiapas, México (LOCAL/TEST)',
      boundary: rectangle(-93.41, 16.735, -93.34, 16.79),
    },
    tuxtla: {
      code: 'LOCAL_TUXTLA',
      name: 'Tuxtla Gutiérrez, Chiapas, México (LOCAL/TEST)',
      boundary: rectangle(-93.2, 16.7, -93.05, 16.8),
    },
  },
  /** Placeholder MXN bands [min, max) in meters; maximum supported distance 10 km. */
  bands: [
    { minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '35.00' },
    { minDistanceMeters: 2000, maxDistanceMeters: 4000, amount: '40.00' },
    { minDistanceMeters: 4000, maxDistanceMeters: 6000, amount: '50.00' },
    { minDistanceMeters: 6000, maxDistanceMeters: 8000, amount: '60.00' },
    { minDistanceMeters: 8000, maxDistanceMeters: 10000, amount: '70.00' },
  ],
  quoteValidityMinutes: 15,
} as const;

/**
 * Idempotent: creates missing zones (ACTIVE when they do not overlap another ACTIVE zone) and an
 * ACTIVE Ocozocoautla LOCAL_DELIVERY plan only if none is active. Existing plans are never edited.
 * Tuxtla intentionally has no plan (demonstrates RATE_CONFIGURATION_UNAVAILABLE / cross-zone).
 */
export async function seedLocalPricing(prisma: PrismaClient) {
  const result: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(LOCAL_PRICING.zones)) {
    const boundary = parseBoundary(def.boundary);
    let zone = await prisma.serviceZone.findUnique({
      where: { code: def.code },
    });
    if (!zone)
      zone = await prisma.serviceZone.create({
        data: {
          code: def.code,
          name: def.name,
          currency: 'MXN',
          boundary: boundary as unknown as Prisma.InputJsonValue,
          ...boundingBox(boundary),
        },
      });
    if (zone.status !== 'ACTIVE') {
      const others = await prisma.serviceZone.findMany({
        where: { status: 'ACTIVE', id: { not: zone.id } },
        select: { code: true, boundary: true },
      });
      const overlap = others.find((o) =>
        boundariesIntersect(
          parseBoundary(zone!.boundary),
          parseBoundary(o.boundary),
        ),
      );
      if (overlap)
        throw new Error(
          `${def.code} overlaps active zone ${overlap.code}; resolve it in the admin API`,
        );
      zone = await prisma.serviceZone.update({
        where: { id: zone.id },
        data: { status: 'ACTIVE' },
      });
    }
    result[key] = { id: zone.id, code: zone.code, status: zone.status };
  }
  const ocoz = await prisma.serviceZone.findUniqueOrThrow({
    where: { code: LOCAL_PRICING.zones.ocozocoautla.code },
  });
  let plan = await prisma.ratePlan.findFirst({
    where: {
      serviceZoneId: ocoz.id,
      serviceType: 'LOCAL_DELIVERY',
      status: 'ACTIVE',
    },
  });
  if (!plan) {
    const bands = LOCAL_PRICING.bands.map((b) => ({ ...b, currency: 'MXN' }));
    if (!validateBands(bands, 'MXN').valid)
      throw new Error('Invalid local bands');
    plan = await prisma.$transaction(async (tx) => {
      const last = await tx.ratePlan.aggregate({
        where: { serviceZoneId: ocoz.id, serviceType: 'LOCAL_DELIVERY' },
        _max: { version: true },
      });
      const draft = await tx.ratePlan.create({
        data: {
          serviceZoneId: ocoz.id,
          serviceType: 'LOCAL_DELIVERY',
          version: (last._max.version ?? 0) + 1,
          quoteValidityMinutes: LOCAL_PRICING.quoteValidityMinutes,
          currency: 'MXN',
          bands: { create: bands },
        },
      });
      return tx.ratePlan.update({
        where: { id: draft.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });
    });
  }
  result.ocozocoautlaPlan = {
    id: plan.id,
    version: plan.version,
    status: plan.status,
  };
  return result;
}
