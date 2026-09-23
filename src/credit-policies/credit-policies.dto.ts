import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  CreditAccountOwnerType,
  CreditCalculationType,
  CreditPolicyStatus,
  ServiceType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { PRINTABLE_TEXT } from '../credits/credit-policy.js';
import {
  MAX_DISTANCE_METERS,
  MAX_POLICY_CREDITS,
  MAX_POLICY_RANGES,
  POLICY_REASON_MAX,
  POLICY_REASON_MIN,
} from './credit-policy-engine.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const credits =
  'Créditos Mandaria enteros (no dinero: sin moneda ni decimales).';

export class CreditPolicyRangeDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_DISTANCE_METERS,
    example: 3000,
    description:
      'Inicio del rango en metros, **inclusivo**. El primer rango empieza en 0 y cada rango empieza donde termina el anterior.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_DISTANCE_METERS)
  minDistanceMeters!: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: MAX_DISTANCE_METERS,
    example: 5000,
    description:
      'Fin del rango en metros, **exclusivo** ([min, max)). `null` sólo en el último rango: «en adelante».',
  })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(MAX_DISTANCE_METERS)
  maxDistanceMeters!: number | null;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_POLICY_CREDITS,
    example: 5,
    description: `Créditos que cuesta un servicio cuya distancia cae en este rango. ${credits}`,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_POLICY_CREDITS)
  credits!: number;
}

/**
 * The economic configuration of one version. Only the fields of its calculationType may be sent;
 * a field of another type is rejected (400), never silently ignored. version, status, dates and
 * author are always decided by the server.
 */
export class CreditPolicyConfigDto {
  @ApiProperty({
    enum: CreditCalculationType,
    description:
      'PER_KM: max(ceil(km) × creditsPerKm, minimumCredits). FLAT: flatCredits siempre. DISTANCE_RANGE: créditos del único rango que contiene la distancia.',
  })
  @IsEnum(CreditCalculationType)
  calculationType!: CreditCalculationType;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_POLICY_CREDITS,
    example: 1,
    description:
      'Sólo y obligatorio con PER_KM: créditos por kilómetro facturable.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_POLICY_CREDITS)
  creditsPerKm?: number;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: MAX_POLICY_CREDITS,
    example: 3,
    description:
      'Sólo y obligatorio con PER_KM: costo mínimo por servicio (0 permitido).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POLICY_CREDITS)
  minimumCredits?: number;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_POLICY_CREDITS,
    example: 5,
    description: 'Sólo y obligatorio con FLAT: costo fijo por servicio.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_POLICY_CREDITS)
  flatCredits?: number;
  @ApiPropertyOptional({
    type: CreditPolicyRangeDto,
    isArray: true,
    maxItems: MAX_POLICY_RANGES,
    description:
      'Sólo y obligatorio con DISTANCE_RANGE: rangos [min, max) contiguos desde 0, el último abierto (maxDistanceMeters null). Sin huecos ni solapes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POLICY_RANGES)
  @ValidateNested({ each: true })
  @Type(() => CreditPolicyRangeDto)
  ranges?: CreditPolicyRangeDto[];
  @ApiPropertyOptional({
    minLength: POLICY_REASON_MIN,
    maxLength: POLICY_REASON_MAX,
    example: 'Tarifa de lanzamiento',
    description:
      'Motivo de esta versión (auditoría). Sin caracteres de control.',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(POLICY_REASON_MIN)
  @MaxLength(POLICY_REASON_MAX)
  @Matches(PRINTABLE_TEXT)
  reason?: string;
}

export class CreateCreditPolicyDto extends CreditPolicyConfigDto {
  @ApiProperty({ enum: ServiceType })
  @IsEnum(ServiceType)
  serviceType!: ServiceType;
  @ApiProperty({
    enum: CreditAccountOwnerType,
    description:
      'Quién paga: PROVIDER (el proveedor, también por sus Drivers de flotilla) o INDEPENDENT_DRIVER. Nunca DRIVER genérico.',
  })
  @IsEnum(CreditAccountOwnerType)
  actorType!: CreditAccountOwnerType;
}

/** A new version keeps serviceType and actorType of the version it supersedes. */
export class CreateCreditPolicyVersionDto extends CreditPolicyConfigDto {}

export class CreditPolicyListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ServiceType })
  @IsOptional()
  @IsEnum(ServiceType)
  serviceType?: ServiceType;
  @ApiPropertyOptional({ enum: CreditAccountOwnerType })
  @IsOptional()
  @IsEnum(CreditAccountOwnerType)
  actorType?: CreditAccountOwnerType;
  @ApiPropertyOptional({ enum: CreditPolicyStatus })
  @IsOptional()
  @IsEnum(CreditPolicyStatus)
  status?: CreditPolicyStatus;
}

export class CreditCostQueryDto {
  @ApiProperty({ enum: ServiceType })
  @IsEnum(ServiceType)
  serviceType!: ServiceType;
  @ApiProperty({ enum: CreditAccountOwnerType })
  @IsEnum(CreditAccountOwnerType)
  actorType!: CreditAccountOwnerType;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_DISTANCE_METERS,
    example: 6240,
    description:
      'Distancia canónica en metros enteros (la que Mandaria ya calculó para el servicio). No se consulta routing.',
  })
  // Only a plain string of digits becomes a number: '', '1.5', '1e20', ' 7' or a repeated
  // parameter stay as they are and fail IsInt (Number('') would silently be 0 meters).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d{1,10}$/.test(value)
      ? Number(value)
      : value,
  )
  @IsInt()
  @Min(0)
  @Max(MAX_DISTANCE_METERS)
  distanceMeters!: number;
}
