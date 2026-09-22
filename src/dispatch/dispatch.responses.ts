import {
  creditEnforcementDoc,
  creditEnforcementModes,
} from '../credits/award-boundary.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DispatchCandidateStatus,
  DispatchStatus,
  GoodsPaymentMode,
  PackageCategory,
  ProviderServiceCoverageStatus,
  ServiceType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';
import {
  DispatchCreditSnapshotResponse,
  creditCostDoc,
} from '../credit-policies/dispatch-credit-snapshots.responses.js';

const statusDoc =
  'Estado efectivo. OPEN: reclamable hasta expiresAt. CLAIMED: tomado por un proveedor (su claim no caduca con expiresAt). EXPIRED: ventana cerrada sin claim vigente (un OPEN vencido se informa EXPIRED aunque aún no se haya persistido). CANCELLED: la DeliveryRequest fue cancelada.';

class ZoneRefResponse {
  @ApiProperty({ example: 'OCOZOCOAUTLA' }) code!: string;
  @ApiProperty({ example: 'Ocozocoautla de Espinosa' }) name!: string;
}
class MyCandidateResponse {
  @ApiProperty({
    enum: DispatchCandidateStatus,
    description:
      'OFFERED: puede reclamar mientras el Dispatch esté OPEN. CLAIMED: lo tomó (o lo tenía al cancelarse). RELEASED: lo liberó y ya no puede reclamarlo.',
  })
  status!: DispatchCandidateStatus;
  @ApiProperty({ format: 'date-time' }) offeredAt!: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  claimedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  releasedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true }) releaseReason!:
    string | null;
}
class MoneyResponse {
  @ApiProperty({ example: '50.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
class RouteResponse {
  @ApiProperty({ example: 4700 }) distanceMeters!: number;
  @ApiProperty({ example: 780 }) durationSeconds!: number;
}
class StopResponse {
  @ApiProperty() address!: string;
  @ApiProperty({ example: 16.7614 }) latitude!: number;
  @ApiProperty({ example: -93.3743 }) longitude!: number;
  @ApiPropertyOptional({ description: 'Sólo access OWNER.' })
  contactName?: string;
  @ApiPropertyOptional({ description: 'Sólo access OWNER.' })
  contactPhone?: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sólo access OWNER.',
  })
  instructions?: string | null;
}
class PackageResponse {
  @ApiProperty({ enum: PackageCategory }) category!: PackageCategory;
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiPropertyOptional({ type: Number, nullable: true })
  weightKg!: number | null;
  @ApiProperty() isFragile!: boolean;
  @ApiPropertyOptional({ description: 'Sólo access OWNER.' })
  description?: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sólo access OWNER.',
  })
  handlingInstructions?: string | null;
}
class GoodsResponse {
  @ApiProperty({ enum: GoodsPaymentMode }) paymentMode!: GoodsPaymentMode;
  @ApiPropertyOptional({ type: String, nullable: true, example: '450.00' })
  value!: string | null;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({
    description:
      'true con COURIER_ADVANCE: el repartidor adelanta el valor de la mercancía al recoger.',
  })
  driverAdvancesGoods!: boolean;
}
class ServiceDetailResponse {
  @ApiProperty({
    type: MoneyResponse,
    description: 'Precio logístico congelado de la Quote aceptada.',
  })
  deliveryFee!: MoneyResponse;
  @ApiProperty({ type: RouteResponse }) route!: RouteResponse;
  @ApiProperty({ type: StopResponse }) pickup!: StopResponse;
  @ApiProperty({ type: StopResponse }) dropoff!: StopResponse;
  @ApiProperty({ type: PackageResponse, isArray: true })
  packages!: PackageResponse[];
  @ApiPropertyOptional({ type: GoodsResponse, nullable: true })
  goods!: GoodsResponse | null;
  @ApiPropertyOptional({ example: 'MDR-000001', description: 'Sólo OWNER.' })
  deliveryRequestPublicId?: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sólo OWNER.',
  })
  externalReference?: string | null;
}
export class ProviderDispatchResponse {
  @ApiProperty({
    enum: creditEnforcementModes,
    description: creditEnforcementDoc,
  })
  creditEnforcementMode!: (typeof creditEnforcementModes)[number];
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DispatchStatus, description: statusDoc })
  status!: DispatchStatus;
  @ApiProperty({
    enum: ['OWNER', 'OFFER', 'SUMMARY'],
    description:
      'OWNER: mi proveedor tiene el claim (detalle completo con contactos). OFFER: puedo reclamarlo (ruta, direcciones, paquetes sin texto libre, tarifa y mercancía; sin contactos, instrucciones ni referencias). SUMMARY: sin detalle del servicio (tomado por otro, vencido, cancelado o liberado por mí). Nunca se exponen el IntegrationClient ni otros candidatos.',
  })
  access!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ type: ZoneRefResponse }) serviceZone!: ZoneRefResponse;
  @ApiProperty({ format: 'date-time' }) openedAt!: Date;
  @ApiProperty({
    format: 'date-time',
    description:
      'Fin de la ventana para reclamar (DISPATCH_TTL_MINUTES desde openedAt). Independiente de la vigencia de la Quote.',
  })
  expiresAt!: Date;
  @ApiProperty() claimedByMe!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  claimedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 1,
    example: 7,
    description: creditCostDoc('mi proveedor'),
  })
  creditCost!: number | null;
  @ApiPropertyOptional({ type: MyCandidateResponse, nullable: true })
  myCandidate!: MyCandidateResponse | null;
  @ApiPropertyOptional({ type: ServiceDetailResponse, nullable: true })
  service!: ServiceDetailResponse | null;
}
export class ProviderDispatchPageResponse extends PaginationResponse {
  @ApiProperty({ type: ProviderDispatchResponse, isArray: true })
  items!: ProviderDispatchResponse[];
}

class ProviderRefResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
}
class AdminCandidateResponse {
  @ApiProperty({ type: ProviderRefResponse }) provider!: ProviderRefResponse;
  @ApiProperty({ enum: DispatchCandidateStatus })
  status!: DispatchCandidateStatus;
  @ApiProperty({ format: 'date-time' }) offeredAt!: Date;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  claimedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  releasedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true }) releaseReason!:
    string | null;
}
class AdminRequestRefResponse {
  @ApiProperty({ example: 'MDR-000001' }) publicId!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'uuid' }) integrationClientId!: string;
}
class AdminQuoteRefResponse {
  @ApiProperty({ example: 'MQ-000001' }) publicId!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty() serviceZone!: ProviderRefResponse;
  @ApiProperty({ example: '50.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
export class AdminDispatchResponse {
  @ApiProperty({
    enum: creditEnforcementModes,
    description: creditEnforcementDoc,
  })
  creditEnforcementMode!: (typeof creditEnforcementModes)[number];
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DispatchStatus, description: statusDoc })
  status!: DispatchStatus;
  @ApiProperty({ format: 'date-time' }) openedAt!: Date;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Proveedor con el claim. Se conserva como histórico si un Dispatch CLAIMED se cancela; se limpia al liberar.',
  })
  claimedByProviderId!: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  claimedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  expiredAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'DELIVERY_REQUEST_CANCELLED',
  })
  cancellationReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ type: AdminRequestRefResponse })
  deliveryRequest!: AdminRequestRefResponse;
  @ApiProperty({ type: AdminQuoteRefResponse })
  deliveryQuote!: AdminQuoteRefResponse;
  @ApiProperty({
    description:
      'Señal derivada (no es estado): OPEN sin candidaturas OFFERED; nadie puede reclamarlo y quedará EXPIRED al vencer.',
  })
  noProviderAvailable!: boolean;
  @ApiProperty({ type: AdminCandidateResponse, isArray: true })
  candidates!: AdminCandidateResponse[];
  @ApiPropertyOptional({ type: GoodsResponse, nullable: true })
  goods!: GoodsResponse | null;
  @ApiProperty({
    type: DispatchCreditSnapshotResponse,
    isArray: true,
    description:
      'V1.10-C: costo congelado por tipo de actor que puede adjudicarse el servicio, con la versión de política y la evidencia del cálculo. Vacío en Dispatches anteriores a V1.10-C.',
  })
  creditSnapshots!: DispatchCreditSnapshotResponse[];
  @ApiProperty({
    description:
      'true si el Dispatch se abrió antes de V1.10-C y no tiene costo registrado (legacy). No se inventan costos retroactivos.',
  })
  legacyWithoutCreditSnapshots!: boolean;
}
export class AdminDispatchPageResponse extends PaginationResponse {
  @ApiProperty({ type: AdminDispatchResponse, isArray: true })
  items!: AdminDispatchResponse[];
}
class CoverageZoneResponse extends ProviderRefResponse {
  @ApiProperty({ example: 'ACTIVE' }) status!: string;
}
export class ServiceCoverageResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ enum: ProviderServiceCoverageStatus })
  status!: ProviderServiceCoverageStatus;
  @ApiProperty({ type: CoverageZoneResponse })
  serviceZone!: CoverageZoneResponse;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
