import { ApiProperty } from '@nestjs/swagger';
import {
  CreditAccountOwnerType,
  CreditCalculationType,
  ServiceType,
} from '@prisma/client';

// Every nullable property declares its type explicitly (a `X | null` union reflects as Object).

/** V1.10-C SUPER_ADMIN audit view of the credit cost frozen for one actor when a Dispatch opened. */
export class DispatchCreditSnapshotResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: CreditAccountOwnerType,
    description:
      'Quién pagaría: PROVIDER (también por sus Drivers de flotilla) o INDEPENDENT_DRIVER.',
  })
  actorType!: CreditAccountOwnerType;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({
    format: 'uuid',
    description:
      'Versión de CreditPolicy usada (la ACTIVE al abrir el Dispatch).',
  })
  creditPolicyId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) policyVersion!: number;
  @ApiProperty({ enum: CreditCalculationType })
  calculationType!: CreditCalculationType;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Distancia canónica copiada de la DeliveryQuote del Dispatch (la que fijó el routing al cotizar). No se volvió a consultar routing.',
  })
  distanceMeters!: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'PER_KM: ceil(distanceMeters / 1000) aplicado. null en los demás tipos.',
  })
  billableKm!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'PER_KM: tarifa congelada.',
  })
  creditsPerKm!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'PER_KM: mínimo congelado.',
  })
  minimumCredits!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'PER_KM: billableKm × creditsPerKm antes del mínimo.',
  })
  calculatedCredits!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'FLAT: costo fijo congelado.',
  })
  flatCredits!: number | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DISTANCE_RANGE: rango aplicado.',
  })
  appliedRangeId!: string | null;
  @ApiProperty({ type: 'integer', nullable: true }) appliedRangePosition!:
    number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'DISTANCE_RANGE: inicio del rango aplicado (inclusivo).',
  })
  appliedRangeMinDistanceMeters!: number | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'DISTANCE_RANGE: fin del rango aplicado (exclusivo); null si era el rango abierto.',
  })
  appliedRangeMaxDistanceMeters!: number | null;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 1000000,
    description:
      'Costo congelado en créditos enteros. V1.10-C no lo descuenta de ninguna cuenta.',
  })
  credits!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export const creditCostDoc = (actor: string) =>
  `V1.10-C: créditos que costaría a ${actor} adjudicarse este servicio, congelados al abrir el Dispatch con la política ACTIVE de entonces; un cambio posterior de política no lo altera. Son créditos, no dinero: no forman parte de deliveryFee, goods ni paymentContext. null = Dispatch abierto antes de V1.10-C (legacy, sin costo registrado). V1.10-C todavía no descuenta créditos al reclamar ni al tomar.`;
