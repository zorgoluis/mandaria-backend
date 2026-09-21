import type { Prisma } from '@prisma/client';

/**
 * Administrative view of the capability. Driver identity (name, operational status, provider
 * affiliation) is read from Driver, never copied into the profile.
 */
export const independentProfileSelect = {
  id: true,
  driverId: true,
  status: true,
  approvedAt: true,
  approvedByUserId: true,
  suspendedAt: true,
  suspendedByUserId: true,
  rejectedAt: true,
  rejectedByUserId: true,
  reason: true,
  createdAt: true,
  updatedAt: true,
  driver: {
    select: {
      id: true,
      name: true,
      status: true,
      availability: true,
      providerId: true,
      user: { select: { id: true, email: true, active: true } },
    },
  },
  _count: { select: { vehicles: true } },
} satisfies Prisma.IndependentDriverProfileSelect;

/** An independent vehicle has no providerId and no V1.4 driver pairing: its owner is the profile. */
export const independentVehicleSelect = {
  id: true,
  independentDriverProfileId: true,
  identifier: true,
  type: true,
  status: true,
  brand: true,
  model: true,
  year: true,
  color: true,
  plate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VehicleSelect;
