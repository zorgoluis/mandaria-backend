import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ServiceType,
  DeliveryRequestStatus,
  DeliveryStopType,
  GoodsPaymentMode,
  PackageCategory,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

const dateTime = { format: 'date-time' } as const;

export class DeliveryStopResponse {
  @ApiProperty({ enum: DeliveryStopType }) type!: DeliveryStopType;
  @ApiProperty({ example: 1 }) sequence!: number;
  @ApiProperty({ example: 'Av. Central 123, Tuxtla Gutiérrez' })
  address!: string;
  @ApiProperty({ example: 16.753554 }) latitude!: number;
  @ApiProperty({ example: -93.115983 }) longitude!: number;
  @ApiProperty({ example: 'Restaurante Centro' }) contactName!: string;
  @ApiProperty({ example: '+52 961 123 4567' }) contactPhone!: string;
  @ApiPropertyOptional({ nullable: true }) instructions!: string | null;
}
export class DeliveryPackageResponse {
  @ApiProperty({ enum: PackageCategory }) category!: PackageCategory;
  @ApiProperty({ example: 'Pedido preparado' }) description!: string;
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiPropertyOptional({ nullable: true, example: 1.5 }) weightKg!:
    number | null;
  @ApiPropertyOptional({ nullable: true }) lengthCm!: number | null;
  @ApiPropertyOptional({ nullable: true }) widthCm!: number | null;
  @ApiPropertyOptional({ nullable: true }) heightCm!: number | null;
  @ApiProperty({ example: false }) isFragile!: boolean;
  @ApiPropertyOptional({ nullable: true }) handlingInstructions!: string | null;
}
export class DeliveryFinancialContextResponse {
  @ApiPropertyOptional({
    nullable: true,
    type: 'string',
    example: '450.00',
    description: 'Decimal string con 2 decimales; nunca float.',
  })
  goodsValue!: string | null;
  @ApiProperty({ enum: GoodsPaymentMode }) goodsPaymentMode!: GoodsPaymentMode;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
class DeliveryRequestBase {
  @ApiProperty({
    example: 'MDR-000123',
    description: 'Identificador operacional global.',
  })
  publicId!: string;
  @ApiPropertyOptional({ nullable: true, example: 'ORDER-1842' })
  externalReference!: string | null;
  @ApiProperty({ enum: ServiceType, example: 'LOCAL_DELIVERY' })
  serviceType!: ServiceType;
  @ApiProperty({ enum: DeliveryRequestStatus, example: 'CREATED' })
  status!: DeliveryRequestStatus;
  @ApiProperty({
    ...dateTime,
    description: 'Momento en que Mandaria aceptó la solicitud.',
  })
  requestedAt!: Date;
  @ApiPropertyOptional({ ...dateTime, nullable: true })
  cancelledAt!: Date | null;
  @ApiProperty(dateTime) createdAt!: Date;
  @ApiProperty(dateTime) updatedAt!: Date;
}
class DeliveryRequestContent extends DeliveryRequestBase {
  @ApiPropertyOptional({ nullable: true, example: null })
  cancellationReason!: string | null;
  @ApiProperty({ type: DeliveryStopResponse, isArray: true })
  stops!: DeliveryStopResponse[];
  @ApiProperty({ type: DeliveryPackageResponse, isArray: true })
  packages!: DeliveryPackageResponse[];
  @ApiProperty({ type: DeliveryFinancialContextResponse })
  financialContext!: DeliveryFinancialContextResponse;
}
/** B2B detail: no internal UUIDs. */
export class DeliveryRequestResponse extends DeliveryRequestContent {}
export class DeliveryRequestSummaryResponse extends DeliveryRequestBase {}
export class DeliveryRequestPageResponse extends PaginationResponse {
  @ApiProperty({ type: DeliveryRequestSummaryResponse, isArray: true })
  items!: DeliveryRequestSummaryResponse[];
}
class IntegrationClientSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Coita Eats' }) name!: string;
  @ApiProperty({ example: 'COITA_EATS' }) code!: string;
}
export class AdminDeliveryRequestSummaryResponse extends DeliveryRequestBase {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) integrationClientId!: string;
  @ApiProperty({ type: IntegrationClientSummaryResponse })
  integrationClient!: IntegrationClientSummaryResponse;
}
export class AdminDeliveryRequestResponse extends DeliveryRequestContent {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) integrationClientId!: string;
  @ApiProperty({ type: IntegrationClientSummaryResponse })
  integrationClient!: IntegrationClientSummaryResponse;
}
export class AdminDeliveryRequestPageResponse extends PaginationResponse {
  @ApiProperty({ type: AdminDeliveryRequestSummaryResponse, isArray: true })
  items!: AdminDeliveryRequestSummaryResponse[];
}
