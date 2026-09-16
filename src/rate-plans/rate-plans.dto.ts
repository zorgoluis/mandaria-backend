import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  RateCalculationType,
  RatePlanStatus,
  ServiceType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { CURRENCIES } from '../service-zones/service-zones.dto.js';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
/**
 * Quote validity policy per service type (minutes). The database allows up to 7 days for future
 * services (e.g. FREIGHT); LOCAL_DELIVERY is capped at 2 hours. Recommended LOCAL_DELIVERY: 15.
 */
export const QUOTE_VALIDITY_LIMITS: Record<
  ServiceType,
  { min: number; max: number }
> = {
  LOCAL_DELIVERY: { min: 1, max: 120 },
};

export class RateBandDto {
  @ApiProperty({
    example: 2000,
    minimum: 0,
    description: 'Inclusivo, en metros.',
  })
  @IsInt()
  @Min(0)
  @Max(1000000)
  minDistanceMeters!: number;
  @ApiProperty({
    example: 4000,
    description: 'Exclusivo, en metros; mayor que minDistanceMeters.',
  })
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxDistanceMeters!: number;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'number' }],
    example: '40.00',
    description:
      'Monto > 0 con hasta 2 decimales (NUMERIC(14,2)); se devuelve como string.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value,
  )
  @IsString()
  @Matches(MONEY, {
    message: 'amount must be a positive decimal with up to 2 decimals',
  })
  amount!: string;
  @ApiPropertyOptional({
    example: 'MXN',
    description: 'Debe coincidir con la moneda del plan (zona).',
  })
  @Transform(upper)
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(CURRENCIES)
  currency?: string;
}
export class CreateRatePlanDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceZoneId!: string;
  @ApiProperty({ enum: ServiceType, example: 'LOCAL_DELIVERY' })
  @IsEnum(ServiceType)
  serviceType!: ServiceType;
  @ApiPropertyOptional({ enum: RateCalculationType, default: 'DISTANCE_BANDS' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(RateCalculationType)
  calculationType?: RateCalculationType;
  @ApiProperty({
    example: 15,
    minimum: 1,
    maximum: 10080,
    description:
      'Vigencia de las Quotes (minutos). LOCAL_DELIVERY: 1–120; recomendado 15.',
  })
  @IsInt()
  @Min(1)
  @Max(10080)
  quoteValidityMinutes!: number;
  @ApiPropertyOptional({ type: RateBandDto, isArray: true, maxItems: 100 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RateBandDto)
  bands?: RateBandDto[];
}
export class UpdateRatePlanDto {
  @ApiProperty({ example: 15, minimum: 1, maximum: 10080 })
  @IsInt()
  @Min(1)
  @Max(10080)
  quoteValidityMinutes!: number;
}
export class ReplaceRateBandsDto {
  @ApiProperty({ type: RateBandDto, isArray: true, maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RateBandDto)
  bands!: RateBandDto[];
}
export class RatePlanListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  serviceZoneId?: string;
  @ApiPropertyOptional({ enum: ServiceType })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(ServiceType)
  serviceType?: ServiceType;
  @ApiPropertyOptional({ enum: RatePlanStatus })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(RatePlanStatus)
  status?: RatePlanStatus;
}
