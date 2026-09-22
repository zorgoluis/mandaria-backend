import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DeliveryRequestStatus,
  DeliveryStopType,
  GoodsPaymentMode,
  PackageCategory,
  ServiceType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const defined = (_o: object, v: unknown) => v !== undefined;
const present = (_o: object, v: unknown) => v !== undefined && v !== null;
const CURRENCIES = Intl.supportedValuesOf('currency');
export const PUBLIC_ID = /^MDR-\d{6,}$/;
/** Up to 12 integer digits and 2 decimals, as JSON number or string; stored as NUMERIC(14,2). */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export class DeliveryStopDto {
  @ApiProperty({
    enum: DeliveryStopType,
    description:
      'V1.5: exactamente un PICKUP (sequence 1) y un DROPOFF (sequence 2).',
    example: 'PICKUP',
  })
  @IsEnum(DeliveryStopType)
  type!: DeliveryStopType;
  @ApiProperty({ minimum: 1, maximum: 2, example: 1 })
  @IsInt()
  @Min(1)
  @Max(2)
  sequence!: number;
  @ApiProperty({
    description:
      'Dirección textual tal como debe mostrarse (snapshot, no referencia externa).',
    example: 'Av. Central 123, Col. Centro, Tuxtla Gutiérrez, Chis.',
    maxLength: 500,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address!: string;
  @ApiProperty({ minimum: -90, maximum: 90, example: 16.753554 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLatitude()
  latitude!: number;
  @ApiProperty({ minimum: -180, maximum: 180, example: -93.115983 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsLongitude()
  longitude!: number;
  @ApiProperty({ example: 'Restaurante Centro', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  contactName!: string;
  @ApiProperty({
    example: '+52 961 123 4567',
    description: 'Dígitos con +, espacios, guiones o paréntesis opcionales.',
    pattern: '^\\+?[0-9 ()-]{7,20}$',
  })
  @Transform(trim)
  @Matches(/^\+?[0-9 ()-]{7,20}$/)
  contactPhone!: string;
  @ApiPropertyOptional({
    type: String,
    example: 'Entregar en mostrador',
    maxLength: 500,
    nullable: true,
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  instructions?: string | null;
}
export class DeliveryPackageDto {
  @ApiProperty({ enum: PackageCategory, example: 'FOOD' })
  @IsEnum(PackageCategory)
  category!: PackageCategory;
  @ApiProperty({
    example: 'Pedido preparado de restaurante',
    maxLength: 200,
    description:
      'Descripción genérica; no enviar productos, precios ni carrito.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  description!: string;
  @ApiProperty({ minimum: 1, maximum: 10000, example: 2 })
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity!: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 1.5,
    description: 'Kilogramos > 0, hasta 3 decimales.',
  })
  @ValidateIf(present)
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false })
  @Min(0.001)
  @Max(100000)
  weightKg?: number | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 30,
    description: 'cm > 0',
  })
  @ValidateIf(present)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100000)
  lengthCm?: number | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 20,
    description: 'cm > 0',
  })
  @ValidateIf(present)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100000)
  widthCm?: number | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 15,
    description: 'cm > 0',
  })
  @ValidateIf(present)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100000)
  heightCm?: number | null;
  @ApiPropertyOptional({ default: false })
  @ValidateIf(defined)
  @IsBoolean()
  isFragile?: boolean;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Mantener vertical',
    maxLength: 500,
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  handlingInstructions?: string | null;
}
export class DeliveryFinancialContextDto {
  @ApiPropertyOptional({
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'number' }],
    example: '450.00',
    description:
      'Valor de la mercancía (no incluye envío). Decimal > 0 con hasta 2 decimales; se recomienda string. Opcional con PREPAID; obligatorio con COURIER_ADVANCE.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value,
  )
  @ValidateIf(present)
  @IsString()
  @Matches(MONEY, {
    message: 'goodsValue must be a positive decimal with up to 2 decimals',
  })
  goodsValue?: string | null;
  @ApiProperty({
    enum: GoodsPaymentMode,
    description:
      'PREPAID: el origen ya cobró la mercancía; el Driver paga 0 en pickup. COURIER_ADVANCE: el Driver adelanta goodsValue en pickup y lo recupera del destinatario en dropoff.',
    example: 'PREPAID',
  })
  @IsEnum(GoodsPaymentMode)
  goodsPaymentMode!: GoodsPaymentMode;
  @ApiProperty({ example: 'MXN', description: 'Código ISO 4217.' })
  @Transform(upper)
  @IsIn(CURRENCIES, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}
export class CreateDeliveryRequestDto {
  @ApiPropertyOptional({
    enum: ServiceType,
    default: 'LOCAL_DELIVERY',
    description:
      'V1.6: sólo LOCAL_DELIVERY (servicio inmediato; sin programación). Omitirlo equivale a LOCAL_DELIVERY.',
  })
  @ValidateIf(defined)
  @IsEnum(ServiceType)
  serviceType?: ServiceType;
  @ApiPropertyOptional({
    type: String,
    example: 'ORDER-1842',
    maxLength: 100,
    nullable: true,
    description:
      'Referencia del sistema externo. No es única ni sustituye a Idempotency-Key: puede repetirse (p. ej. tras cancelar).',
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  externalReference?: string | null;
  @ApiProperty({
    type: DeliveryStopDto,
    isArray: true,
    minItems: 2,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => DeliveryStopDto)
  stops!: DeliveryStopDto[];
  @ApiProperty({
    type: DeliveryPackageDto,
    isArray: true,
    minItems: 1,
    maxItems: 50,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DeliveryPackageDto)
  packages!: DeliveryPackageDto[];
  @ApiProperty({ type: DeliveryFinancialContextDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeliveryFinancialContextDto)
  financialContext!: DeliveryFinancialContextDto;
}
export class CancelDeliveryRequestDto {
  @ApiProperty({ example: 'El cliente canceló el pedido', maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
export class DeliveryRequestListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'MDR-000123', pattern: PUBLIC_ID.source })
  @Transform(upper)
  @ValidateIf(defined)
  @Matches(PUBLIC_ID)
  publicId?: string;
  @ApiPropertyOptional({
    example: 'ORDER-1842',
    description: 'Coincidencia exacta.',
  })
  @Transform(trim)
  @ValidateIf(defined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  externalReference?: string;
  @ApiPropertyOptional({ enum: DeliveryRequestStatus })
  @ValidateIf(defined)
  @IsEnum(DeliveryRequestStatus)
  status?: DeliveryRequestStatus;
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'requestedAt >= requestedFrom (ISO 8601).',
  })
  @ValidateIf(defined)
  @IsDateString({ strict: true })
  requestedFrom?: string;
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'requestedAt <= requestedTo (ISO 8601).',
  })
  @ValidateIf(defined)
  @IsDateString({ strict: true })
  requestedTo?: string;
}
export class AdminDeliveryRequestListQueryDto extends DeliveryRequestListQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'IntegrationClient.id' })
  @ValidateIf(defined)
  @IsUUID()
  integrationClientId?: string;
}
