import { ApiProperty } from '@nestjs/swagger';
import { PrequoteStop, PrequotePackage } from './prequote-conditions.js';
class PrequoteFoodPackage extends PrequotePackage {
  @ApiProperty({ enum: ['FOOD'], example: 'FOOD' })
  declare category: PrequotePackage['category'];
}

/** Documentation only: normalizePrequoteConditions is the sole runtime validation authority. */
export class CreatePrequoteDto {
  @ApiProperty({
    enum: [1],
    description: 'Obligatorio, sin default. Versión de condiciones canónicas.',
    example: 1,
  })
  conditionsVersion!: number;
  @ApiProperty({
    enum: ['LOCAL_DELIVERY'],
    description: 'Sólo servicio inmediato. No admite programación.',
  })
  serviceType!: string;
  @ApiProperty({
    type: [PrequoteStop],
    minItems: 2,
    maxItems: 2,
    description:
      'PICKUP/1 y DROPOFF/2; coordenadas hasta 6 decimales; sin direcciones ni contactos.',
  })
  stops!: PrequoteStop[];
  @ApiProperty({
    type: [PrequoteFoodPackage],
    minItems: 1,
    maxItems: 50,
    description:
      'Sólo FOOD. Orden canónico por contenido; conserva multiplicidad. Medidas omitidas/null equivalentes; isFragile omitido=false, null inválido.',
  })
  packages!: PrequotePackage[];
}
class PrequoteZoneResponse {
  @ApiProperty({ example: 'CENTRO' }) code!: string;
  @ApiProperty({ example: 'Zona Centro' }) name!: string;
}
export class PrequoteResponse {
  @ApiProperty({ example: 'MPQ-000123' }) publicId!: string;
  @ApiProperty({
    enum: ['OFFERED', 'EXPIRED'],
    description:
      'EXPIRED cuando now >= expiresAt. No se persiste ni renueva por replay.',
  })
  status!: string;
  @ApiProperty({ enum: [1] }) conditionsVersion!: number;
  @ApiProperty({
    type: CreatePrequoteDto,
    description:
      'Condiciones normalizadas completas, incluida conditionsVersion; medidas siempre presentes como número o null.',
  })
  conditions!: CreatePrequoteDto;
  @ApiProperty({
    type: PrequoteZoneResponse,
    description: 'Código y nombre congelados al emitir.',
  })
  serviceZone!: PrequoteZoneResponse;
  @ApiProperty({ minimum: 0 }) distanceMeters!: number;
  @ApiProperty({
    minimum: 0,
    description: 'Duración calculada de ruta, no promesa de llegada.',
  })
  durationSeconds!: number;
  @ApiProperty({ example: '60.00', pattern: '^\\d+\\.\\d{2}$' })
  amount!: string;
  @ApiProperty({ enum: ['MXN'] }) currency!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Reloj DB de publicación; issuedAt interno.',
  })
  createdAt!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Vigencia absoluta independiente del TTL de RatePlan.',
  })
  expiresAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [null],
    description: 'Siempre null; conversión no implementada.',
  })
  convertedAt!: null;
  @ApiProperty({ type: String, nullable: true, enum: [null] })
  deliveryRequestPublicId!: null;
  @ApiProperty({ type: String, nullable: true, enum: [null] })
  deliveryQuotePublicId!: null;
  @ApiProperty({
    enum: [false],
    type: Boolean,
    description: 'No reserva capacidad logística.',
  })
  availabilityGuaranteed!: false;
}
