import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProviderStatus } from '@prisma/client';

type LockedProvider = {
  id: string;
  status: ProviderStatus;
  maxDrivers: number;
  maxVehicles: number;
};
/**
 * Locks the provider row inside a transaction. FOR UPDATE serializes creations that consume
 * capacity with limit edits and suspension; FOR SHARE lets reads that depend on status
 * (availability, assignments) run together while still waiting for those writers.
 * Lock order across V1.4 is always provider → driver → vehicle to avoid deadlocks.
 */
export async function lockProvider(
  tx: Prisma.TransactionClient,
  id: string,
  mode: 'UPDATE' | 'SHARE' = 'UPDATE',
) {
  const rows =
    mode === 'UPDATE'
      ? await tx.$queryRaw<
          LockedProvider[]
        >`SELECT id, status, "maxDrivers", "maxVehicles" FROM "DeliveryProvider" WHERE id = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<
          LockedProvider[]
        >`SELECT id, status, "maxDrivers", "maxVehicles" FROM "DeliveryProvider" WHERE id = ${id}::uuid FOR SHARE`;
  if (!rows.length) throw new NotFoundException('Provider not found');
  return rows[0];
}
export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';
