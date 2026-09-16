import { Prisma } from '@prisma/client';

/**
 * DISTANCE_BANDS semantics (meters, integers): each band covers [minDistanceMeters,
 * maxDistanceMeters) — min inclusive, max exclusive. A complete plan starts at 0 and bands are
 * contiguous (next.min = previous.max), so every distance maps to exactly one band. The maximum
 * supported distance is the last band's max, exclusive.
 */
export type BandInput = {
  minDistanceMeters: number;
  maxDistanceMeters: number;
  amount: string | Prisma.Decimal;
  currency: string;
};

export function validateBands(bands: BandInput[], planCurrency: string) {
  const errors: string[] = [];
  if (!bands.length) errors.push('Rate plan requires at least one band');
  const sorted = [...bands].sort(
    (a, b) => a.minDistanceMeters - b.minDistanceMeters,
  );
  sorted.forEach((band, i) => {
    const label = `band[${band.minDistanceMeters}-${band.maxDistanceMeters})`;
    if (
      !Number.isInteger(band.minDistanceMeters) ||
      !Number.isInteger(band.maxDistanceMeters) ||
      band.minDistanceMeters < 0
    )
      errors.push(`${label}: limits must be non-negative integer meters`);
    if (band.maxDistanceMeters <= band.minDistanceMeters)
      errors.push(
        `${label}: maxDistanceMeters must be greater than minDistanceMeters`,
      );
    if (!new Prisma.Decimal(band.amount).gt(0))
      errors.push(`${label}: amount must be greater than 0`);
    if (band.currency !== planCurrency)
      errors.push(`${label}: currency must be ${planCurrency}`);
    if (i === 0 && band.minDistanceMeters !== 0)
      errors.push(`${label}: first band must start at 0`);
    if (i > 0) {
      const previous = sorted[i - 1];
      if (band.minDistanceMeters > previous.maxDistanceMeters)
        errors.push(
          `gap between ${previous.maxDistanceMeters} and ${band.minDistanceMeters} meters`,
        );
      else if (band.minDistanceMeters < previous.maxDistanceMeters)
        errors.push(
          `overlap between band[${previous.minDistanceMeters}-${previous.maxDistanceMeters}) and ${label}`,
        );
    }
  });
  return { valid: errors.length === 0, errors, sorted };
}

/** Returns the band whose [min, max) range contains the distance, or undefined. */
export function findBand<T extends BandInput>(
  bands: T[],
  distanceMeters: number,
) {
  return bands.find(
    (b) =>
      distanceMeters >= b.minDistanceMeters &&
      distanceMeters < b.maxDistanceMeters,
  );
}
