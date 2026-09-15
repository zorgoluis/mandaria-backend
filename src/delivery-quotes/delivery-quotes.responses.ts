import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryQuoteStatus, ServiceType } from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

class QuoteZoneResponse {
  @ApiProperty({ example: 'OCOZOCOAUTLA' }) code!: string;
  @ApiProperty({ example: 'Ocozocoautla de Espinosa, Chiapas, México' })
  name!: string;
}
export class DeliveryQuoteResponse {
  @ApiProperty({ example: 'MQ-000001' }) publicId!: string;
  @ApiProperty({ example: 'MDR-000001' }) deliveryRequestPublicId!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ type: QuoteZoneResponse }) serviceZone!: QuoteZoneResponse;
  @ApiProperty({
    example: 4700,
    description: 'Distancia de ruta real (m) usada para tarificar.',
  })
  distanceMeters!: number;
  @ApiProperty({ example: 780 }) durationSeconds!: number;
  @ApiProperty({
    type: 'string',
    example: '50.00',
    description:
      'Precio logístico congelado. No incluye goodsValue de la mercancía.',
  })
  amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({
    enum: DeliveryQuoteStatus,
    description:
      'Estado efectivo: una OFFERED con expiresAt vencido se informa como EXPIRED.',
  })
  status!: DeliveryQuoteStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({
    format: 'date-time',
    description:
      'Fin de la vigencia del precio. No indica cuándo se realiza el servicio.',
  })
  expiresAt!: Date;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  acceptedAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiPropertyOptional({
    nullable: true,
    example: 'DELIVERY_REQUEST_CANCELLED',
  })
  cancellationReason!: string | null;
}
export class DeliveryQuotePageResponse extends PaginationResponse {
  @ApiProperty({ type: DeliveryQuoteResponse, isArray: true })
  items!: DeliveryQuoteResponse[];
}
class AdminQuoteRequestResponse {
  @ApiProperty({ example: 'MDR-000001' }) publicId!: string;
  @ApiProperty({ format: 'uuid' }) integrationClientId!: string;
  @ApiProperty() status!: string;
}
class AdminQuotePlanResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 3 }) version!: number;
}
class AdminQuoteBandResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 4000 }) minDistanceMeters!: number;
  @ApiProperty({ example: 6000 }) maxDistanceMeters!: number;
}
class AdminQuoteZoneResponse extends QuoteZoneResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
export class AdminDeliveryQuoteResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'MQ-000001' }) publicId!: string;
  @ApiProperty({ format: 'uuid' }) deliveryRequestId!: string;
  @ApiProperty({ type: AdminQuoteRequestResponse })
  deliveryRequest!: AdminQuoteRequestResponse;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ format: 'uuid' }) serviceZoneId!: string;
  @ApiProperty({ type: AdminQuoteZoneResponse })
  serviceZone!: AdminQuoteZoneResponse;
  @ApiProperty({ format: 'uuid' }) ratePlanId!: string;
  @ApiProperty({ type: AdminQuotePlanResponse })
  ratePlan!: AdminQuotePlanResponse;
  @ApiProperty({ format: 'uuid' }) rateBandId!: string;
  @ApiProperty({ type: AdminQuoteBandResponse })
  rateBand!: AdminQuoteBandResponse;
  @ApiProperty({ example: 4700 }) distanceMeters!: number;
  @ApiProperty({ example: 780 }) durationSeconds!: number;
  @ApiProperty({ type: 'string', example: '50.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ example: 'google' }) routingProvider!: string;
  @ApiProperty({ format: 'date-time' }) routeCalculatedAt!: Date;
  @ApiProperty({ enum: DeliveryQuoteStatus }) status!: DeliveryQuoteStatus;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  acceptedAt!: Date | null;
  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Momento en que se persistió EXPIRED.',
  })
  expiredAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) cancellationReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class AdminDeliveryQuotePageResponse extends PaginationResponse {
  @ApiProperty({ type: AdminDeliveryQuoteResponse, isArray: true })
  items!: AdminDeliveryQuoteResponse[];
}
