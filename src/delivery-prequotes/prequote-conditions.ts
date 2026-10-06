import { PickType } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  DeliveryPackageDto,
  DeliveryStopDto,
} from '../delivery-requests/delivery-requests.dto.js';
import { DomainException } from '../common/domain-error.js';
import { canonicalJson } from '../idempotency/idempotency.service.js';

export class PrequoteStop extends PickType(DeliveryStopDto, [
  'type',
  'sequence',
  'latitude',
  'longitude',
] as const) {}
export class PrequotePackage extends PickType(DeliveryPackageDto, [
  'category',
  'quantity',
  'weightKg',
  'lengthCm',
  'widthCm',
  'heightCm',
  'isFragile',
] as const) {}
const invalid = () =>
  new DomainException(
    'PREQUOTE_CONDITIONS_INVALID',
    400,
    'Invalid prequote conditions',
  );

/** One internal normalizer for A4 and future comparison; never changes legacy normalization. */
export function normalizePrequoteConditions(input: unknown, direct = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) =>
        !['conditionsVersion', 'serviceType', 'stops', 'packages'].includes(k),
    ) ||
    value.conditionsVersion !== 1 ||
    value.serviceType !== 'LOCAL_DELIVERY'
  )
    throw invalid();
  if (
    !Array.isArray(value.stops) ||
    value.stops.length !== 2 ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > 50
  )
    throw invalid();
  const stops = value.stops
    .map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw invalid();
      const stop = plainToInstance(PrequoteStop, raw);
      if (
        validateSync(stop, { whitelist: true, forbidNonWhitelisted: true })
          .length ||
        new Prisma.Decimal(stop.latitude).decimalPlaces() > 6 ||
        new Prisma.Decimal(stop.longitude).decimalPlaces() > 6
      )
        throw invalid();
      return {
        type: stop.type,
        sequence: stop.sequence,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
  if (
    stops[0].type !== 'PICKUP' ||
    stops[0].sequence !== 1 ||
    stops[1].type !== 'DROPOFF' ||
    stops[1].sequence !== 2
  )
    throw invalid();
  const packages = value.packages
    .map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw invalid();
      const item = plainToInstance(PrequotePackage, raw);
      if (
        validateSync(item, { whitelist: true, forbidNonWhitelisted: true })
          .length ||
        (!direct && item.category !== 'FOOD')
      )
        throw invalid();
      return {
        category: item.category,
        quantity: item.quantity,
        weightKg: item.weightKg ?? null,
        lengthCm: item.lengthCm ?? null,
        widthCm: item.widthCm ?? null,
        heightCm: item.heightCm ?? null,
        isFragile: item.isFragile ?? false,
      };
    })
    .sort((a, b) =>
      canonicalJson(a) < canonicalJson(b)
        ? -1
        : canonicalJson(a) > canonicalJson(b)
          ? 1
          : 0,
    );
  return {
    conditionsVersion: 1,
    serviceType: 'LOCAL_DELIVERY' as const,
    stops,
    packages,
  };
}

export const prequoteEffectiveStatus = (
  quote: { expiresAt: Date },
  now: Date,
) => (now >= quote.expiresAt ? ('EXPIRED' as const) : ('OFFERED' as const));
