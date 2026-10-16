import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verificationError } from './verification-error.js';
export const POLICY_VERSION = 'LOCAL-TEST-1';
export const MOTOR_TYPES = [
  'MOTORCYCLE',
  'CAR',
  'PICKUP',
  'VAN',
  'TRUCK',
] as const;
export const CATEGORIES = [
  'FACE_PHOTO',
  'INE_FRONT',
  'INE_BACK',
  'LICENSE',
  'REGISTRATION_CARD',
  'OWNERSHIP_PROOF',
  'RENTAL_CONTRACT',
  'OWNER_AUTHORIZATION',
] as const;
const short = z.string().trim().min(1).max(150);
export const identityData = z
  .object({
    fullName: short,
    contactPhone: z.string().trim().min(5).max(30),
    operatingCity: short,
    documentType: z.literal('INE'),
    license: z
      .object({
        issuer: short,
        category: short,
        expiresAt: z.iso.datetime(),
        vehicleTypes: z.array(z.enum(MOTOR_TYPES)).min(1).max(5),
      })
      .strict()
      .optional(),
  })
  .strict();
export const vehicleData = z
  .object({
    declaredOwnerName: short,
    ownershipEvidenceType: z.enum(['OWNED', 'RENTED', 'BORROWED']),
    serialNumber: short,
    authorizationExpiresAt: z.iso.datetime().optional(),
  })
  .strict();
export type IdentityData = z.infer<typeof identityData>;
export type VehicleData = z.infer<typeof vehicleData>;
export function parseData(driver: boolean, data: unknown) {
  const result = (driver ? identityData : vehicleData).safeParse(data);
  if (!result.success) verificationError('VERIFICATION_DATA_INVALID', 400);
  return result.data;
}
export function categories(driver: boolean, data: Record<string, unknown>) {
  if (driver)
    return [
      'FACE_PHOTO',
      'INE_FRONT',
      'INE_BACK',
      ...(data.license ? ['LICENSE'] : []),
    ];
  return [
    'REGISTRATION_CARD',
    data.ownershipEvidenceType === 'RENTED'
      ? 'RENTAL_CONTRACT'
      : data.ownershipEvidenceType === 'BORROWED'
        ? 'OWNER_AUTHORIZATION'
        : 'OWNERSHIP_PROOF',
  ];
}
export function checks(driver: boolean, data: Record<string, unknown>) {
  return driver
    ? [
        'IDENTITY_MATCH',
        'LEGIBLE',
        ...(data.license
          ? ['LICENSE_HOLDER', 'LICENSE_VALIDITY', 'LICENSE_CATEGORY']
          : []),
      ]
    : ['UNIT_MATCH', 'LEGIBLE', 'AUTHORIZED_USE'];
}
export function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
