import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsDateString,
  IsDefined,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CreateDeliveryRequestDto,
  DeliveryFinancialContextDto,
  DeliveryPackageDto,
} from '../delivery-requests/delivery-requests.dto.js';
import { DeliveryQuoteResponse } from '../delivery-quotes/delivery-quotes.responses.js';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class MerchantConfirmationDto {
  @ApiProperty({
    enum: ['CONFIRMED_BY_MERCHANT'],
    description:
      'Declaración del integrador sobre ingreso confirmado por el restaurante, no verificación bancaria Mandaria.',
  })
  @Equals('CONFIRMED_BY_MERCHANT')
  goodsPaymentStatus!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description: 'Referencia opaca; sin comprobantes, datos bancarios ni PII.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  goodsPaymentReference!: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'Fecha confirmada, zona explícita; no futura respecto al reloj DB.',
  })
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  goodsPaymentConfirmedAt!: string;
  @ApiProperty({ enum: ['ACCEPTED_BY_MERCHANT'] })
  @Equals('ACCEPTED_BY_MERCHANT')
  orderAcceptanceStatus!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description: 'Referencia opaca de aceptación del restaurante.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  orderAcceptanceReference!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  orderAcceptedAt!: string;
}
export class CollectionInstructionDto {
  @ApiProperty({ enum: ['RECIPIENT'] }) @Equals('RECIPIENT') payer!: string;
  @ApiProperty({ enum: ['CASH'] }) @Equals('CASH') method!: string;
  @ApiProperty({ enum: ['DELIVERY'] }) @Equals('DELIVERY') dueAt!: string;
  @ApiProperty({
    enum: ['DELIVERY_FEE'],
    isArray: true,
    minItems: 1,
    maxItems: 1,
    description: 'Sólo envío; sin monto paralelo ni cobro efectivo registrado.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @Equals('DELIVERY_FEE', { each: true })
  components!: string[];
}

class ConversionFinancialContextDto extends DeliveryFinancialContextDto {
  @ApiProperty({ enum: ['PREPAID'] })
  @Equals('PREPAID')
  declare goodsPaymentMode: DeliveryFinancialContextDto['goodsPaymentMode'];
  @ApiProperty({ enum: ['MXN'] }) @Equals('MXN') declare currency: string;
}
class ConversionFoodPackageDto extends DeliveryPackageDto {
  @ApiProperty({ enum: ['FOOD'] })
  @Equals('FOOD')
  declare category: DeliveryPackageDto['category'];
}
class ConversionDeliveryRequestDto extends CreateDeliveryRequestDto {
  @ApiProperty({ enum: ['LOCAL_DELIVERY'], required: true })
  @Equals('LOCAL_DELIVERY')
  declare serviceType: NonNullable<CreateDeliveryRequestDto['serviceType']>;
  @ApiProperty({ type: ConversionFinancialContextDto })
  @Type(() => ConversionFinancialContextDto)
  declare financialContext: ConversionFinancialContextDto;
  @ApiProperty({ type: [ConversionFoodPackageDto], minItems: 1, maxItems: 50 })
  @Type(() => ConversionFoodPackageDto)
  declare packages: ConversionFoodPackageDto[];
}

export class ConvertPrequoteDto {
  @ApiProperty({ enum: [1] }) @Equals(1) conditionsVersion!: number;
  @ApiProperty({
    type: ConversionDeliveryRequestDto,
    description:
      'Solicitud completa. En conversión sólo PREPAID/MXN/FOOD y LOCAL_DELIVERY. Datos textuales definitivos incluidos en fingerprint. goodsValue no incluye envío.',
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ConversionDeliveryRequestDto)
  deliveryRequest!: ConversionDeliveryRequestDto;
  @ApiProperty({ type: MerchantConfirmationDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MerchantConfirmationDto)
  merchantConfirmation!: MerchantConfirmationDto;
  @ApiProperty({ type: CollectionInstructionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CollectionInstructionDto)
  deliveryCollectionInstruction!: CollectionInstructionDto;
}
export class PrequoteConversionResponse {
  @ApiProperty({ example: 'MPQ-000101' }) prequotePublicId!: string;
  @ApiProperty({ format: 'date-time' }) convertedAt!: Date;
  @ApiProperty({ example: 'MDR-000101' }) deliveryRequestPublicId!: string;
  @ApiProperty({ type: String, nullable: true }) externalReference!:
    string | null;
  @ApiProperty({
    enum: ['CREATED', 'CANCELLED'],
    description: 'Estado actual; replay no recrea una solicitud cancelada.',
  })
  deliveryRequestStatus!: string;
  @ApiProperty({ type: CollectionInstructionDto })
  deliveryCollectionInstruction!: CollectionInstructionDto;
  @ApiProperty({
    type: DeliveryQuoteResponse,
    description:
      'Snapshot MPQ exacto, expiry original y metadata de zona congelada. No aceptable ni despachable durante B.',
  })
  quote!: DeliveryQuoteResponse;
  @ApiProperty({ enum: [false] }) availabilityGuaranteed!: boolean;
}
