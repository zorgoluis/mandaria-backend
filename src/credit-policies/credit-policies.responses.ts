import { ApiProperty } from '@nestjs/swagger';
import {
  CreditAccountOwnerType,
  CreditCalculationType,
  CreditPolicyStatus,
  ServiceType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

// Every nullable property declares its type explicitly (a `X | null` union reflects as Object).

export class CreditPolicyRangeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: 'Orden 1..n por distancia.',
  })
  position!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Metros, inclusivo.',
  })
  minDistanceMeters!: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Metros, exclusivo. null en el último rango («en adelante»).',
  })
  maxDistanceMeters!: number | null;
  @ApiProperty({ type: 'integer', minimum: 1 }) credits!: number;
}

export class CreditPolicyResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({
    enum: CreditAccountOwnerType,
    description:
      'Quién paga: PROVIDER (también por sus Drivers de flotilla) o INDEPENDENT_DRIVER.',
  })
  actorType!: CreditAccountOwnerType;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description:
      'Monótona por serviceType + actorType; la asigna el servidor (máximo + 1).',
  })
  version!: number;
  @ApiProperty({
    enum: CreditPolicyStatus,
    description:
      'Como máximo una ACTIVE por serviceType + actorType. INACTIVE = reemplazada (historial).',
  })
  status!: CreditPolicyStatus;
  @ApiProperty({ enum: CreditCalculationType })
  calculationType!: CreditCalculationType;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Sólo PER_KM.' })
  creditsPerKm!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Sólo PER_KM.' })
  minimumCredits!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Sólo FLAT.' })
  flatCredits!: number | null;
  @ApiProperty({
    type: CreditPolicyRangeResponse,
    isArray: true,
    description:
      'Sólo DISTANCE_RANGE (vacío en los demás), ordenados por position.',
  })
  ranges!: CreditPolicyRangeResponse[];
  @ApiProperty({
    format: 'date-time',
    description:
      'Cuándo entró en vigor esta versión (al crearla). Sin programación futura.',
  })
  effectiveFrom!: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo la reemplazó la versión siguiente; null mientras está ACTIVE.',
  })
  effectiveUntil!: Date | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({
    format: 'uuid',
    description: 'SUPER_ADMIN que creó la versión.',
  })
  createdByUserId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class CreditPolicyPageResponse extends PaginationResponse {
  @ApiProperty({ type: CreditPolicyResponse, isArray: true })
  items!: CreditPolicyResponse[];
}

export class CreditCostResponse {
  @ApiProperty({ format: 'uuid' }) policyId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) policyVersion!: number;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ enum: CreditAccountOwnerType })
  actorType!: CreditAccountOwnerType;
  @ApiProperty({ enum: CreditCalculationType })
  calculationType!: CreditCalculationType;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Distancia canónica recibida.',
  })
  distanceMeters!: number;
  @ApiProperty({
    example: '6.240',
    description:
      'Sólo informativo: kilómetros exactos con 3 decimales, como texto. No interviene en el cálculo.',
  })
  distanceKm!: string;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'PER_KM: ceil(distanceMeters / 1000). null en los demás tipos.',
  })
  billableKm!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'PER_KM: billableKm × creditsPerKm, antes de aplicar el mínimo.',
  })
  calculatedCredits!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'PER_KM: mínimo de la política.',
  })
  minimumCredits!: number | null;
  @ApiProperty({ description: 'PER_KM: true si el mínimo determinó el costo.' })
  minimumApplied!: boolean;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'DISTANCE_RANGE: position del rango aplicado.',
  })
  rangePosition!: number | null;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Costo en créditos enteros. V1.10-B sólo lo calcula: no se descuenta de ninguna cuenta.',
  })
  credits!: number;
}
