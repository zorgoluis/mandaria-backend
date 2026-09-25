import {
  creditEnforcementDoc,
  creditEnforcementModes,
} from '../credits/award-boundary.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DeliveryAssignmentMode,
  DispatchStatus,
  DriverAvailability,
  DriverStatus,
  GoodsPaymentMode,
  IndependentDriverStatus,
  PackageCategory,
  ServiceType,
  VehicleStatus,
  VehicleType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';
import { creditCostDoc } from '../credit-policies/dispatch-credit-snapshots.responses.js';

class IndependentDriverRefResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Carlos Pérez' }) name!: string;
  @ApiProperty({ enum: DriverStatus }) status!: DriverStatus;
  @ApiProperty({ enum: DriverAvailability })
  availability!: DriverAvailability;
  @ApiProperty({
    format: 'uuid',
    description:
      'Proveedor del que el Driver forma parte en V1.4. No otorga ningún permiso en el contexto independiente: ambos contextos están separados.',
  })
  providerId!: string;
}
export class IndependentDriverProfileResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) driverId!: string;
  @ApiProperty({
    enum: IndependentDriverStatus,
    description:
      'APPROVED: puede tomar servicios. SUSPENDED: se le retiró la habilitación. REJECTED: solicitud cerrada. PENDING: reservado para el alta pública futura; V1.9 no la implementa.',
  })
  status!: IndependentDriverStatus;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  approvedByUserId!: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  suspendedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  suspendedByUserId!: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  rejectedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  rejectedByUserId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ type: IndependentDriverRefResponse })
  driver!: IndependentDriverRefResponse;
}
export class IndependentDriverProfilePageResponse extends PaginationResponse {
  @ApiProperty({ type: IndependentDriverProfileResponse, isArray: true })
  items!: IndependentDriverProfileResponse[];
}

export class IndependentVehicleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Dueño del vehículo. Un vehículo independiente nunca tiene providerId: la pertenencia es excluyente (CHECK Vehicle_owner_check).',
  })
  independentDriverProfileId!: string;
  @ApiProperty({ example: 'MOTO-CARLOS-01' }) identifier!: string;
  @ApiProperty({ enum: VehicleType }) type!: VehicleType;
  @ApiProperty({ enum: VehicleStatus }) status!: VehicleStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) brand!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) model!: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  year!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) color!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) plate!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

class MoneyResponse {
  @ApiProperty({ example: '60.00' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
class RouteResponse {
  @ApiProperty({ example: 4700 }) distanceMeters!: number;
  @ApiProperty({ example: 780 }) durationSeconds!: number;
}
class DriverStopResponse {
  @ApiProperty() address!: string;
  @ApiProperty({ example: 16.7614 }) latitude!: number;
  @ApiProperty({ example: -93.3743 }) longitude!: number;
  @ApiPropertyOptional({ description: 'Sólo access OWNER (servicio tomado).' })
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
class DriverPackageResponse {
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
class DriverServiceResponse {
  @ApiProperty({ type: RouteResponse }) route!: RouteResponse;
  @ApiProperty({ type: DriverStopResponse }) pickup!: DriverStopResponse;
  @ApiProperty({ type: DriverStopResponse }) dropoff!: DriverStopResponse;
  @ApiProperty({ type: DriverPackageResponse, isArray: true })
  packages!: DriverPackageResponse[];
  @ApiPropertyOptional({ example: 'MDR-000001', description: 'Sólo OWNER.' })
  deliveryRequestPublicId?: string;
}
export class DriverPaymentContextResponse {
  @ApiProperty({
    type: MoneyResponse,
    description: 'Lo que paga el servicio logístico (Quote aceptada).',
  })
  deliveryFee!: MoneyResponse;
  @ApiPropertyOptional({
    type: MoneyResponse,
    nullable: true,
    description: 'Valor de la mercancía; nunca se mezcla con deliveryFee.',
  })
  goodsValue!: MoneyResponse | null;
  @ApiPropertyOptional({ enum: GoodsPaymentMode, nullable: true })
  goodsPaymentMode!: GoodsPaymentMode | null;
  @ApiProperty({
    description:
      'true con COURIER_ADVANCE: el repartidor adelanta la mercancía al comercio al recoger y la recupera al entregar.',
  })
  driverAdvancesGoods!: boolean;
  @ApiPropertyOptional({
    type: MoneyResponse,
    nullable: true,
    description:
      'Cuánto debe adelantar. Mandaria no mueve ese dinero ni comprueba si el repartidor dispone de él: no hay wallet ni crédito en V1.9.',
  })
  driverAdvanceAmount!: MoneyResponse | null;
}
class DriverAssignmentVehicleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'MOTO-03' }) identifier!: string;
  @ApiProperty({ enum: VehicleType }) type!: VehicleType;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'ABC-123' })
  plate!: string | null;
}
class DriverAssignmentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DeliveryAssignmentMode, example: 'INDEPENDENT' })
  mode!: DeliveryAssignmentMode;
  @ApiProperty({ format: 'date-time' }) assignedAt!: Date;
  @ApiProperty({ type: DriverAssignmentVehicleResponse })
  vehicle!: DriverAssignmentVehicleResponse;
}
class DriverDispatchZoneResponse {
  @ApiProperty({ example: 'OCOZOCOAUTLA' }) code!: string;
  @ApiProperty({ example: 'Ocozocoautla de Espinosa' }) name!: string;
}
export class DriverDispatchResponse {
  @ApiProperty({
    enum: creditEnforcementModes,
    description: creditEnforcementDoc,
  })
  creditEnforcementMode!: (typeof creditEnforcementModes)[number];
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DispatchStatus }) status!: DispatchStatus;
  @ApiProperty({
    enum: ['OWNER', 'OFFER'],
    description:
      'OFFER: puedo tomarlo (ruta, direcciones, paquetes sin texto libre y contexto de pago; sin contactos ni instrucciones). OWNER: lo tomé (se agregan contactos, instrucciones y referencia del pedido). Nunca se exponen proveedores, candidaturas ni el IntegrationClient.',
  })
  access!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ type: DriverDispatchZoneResponse })
  serviceZone!: DriverDispatchZoneResponse;
  @ApiProperty({ format: 'date-time' }) openedAt!: Date;
  @ApiProperty({
    format: 'date-time',
    description: 'Fin de la ventana para tomarlo.',
  })
  expiresAt!: Date;
  @ApiProperty() takenByMe!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  claimedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'V1.11-A: momento en que confirmé la entrega. null si el servicio no está DELIVERED o no es mío.',
  })
  deliveredAt!: Date | null;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 1,
    example: 14,
    description: creditCostDoc('mí (repartidor independiente)'),
  })
  creditCost!: number | null;
  @ApiPropertyOptional({ type: DriverAssignmentResponse, nullable: true })
  assignment!: DriverAssignmentResponse | null;
  @ApiProperty({ type: DriverServiceResponse })
  service!: DriverServiceResponse;
  @ApiProperty({ type: DriverPaymentContextResponse })
  paymentContext!: DriverPaymentContextResponse;
}
export class DriverDispatchPageResponse extends PaginationResponse {
  @ApiProperty({ type: DriverDispatchResponse, isArray: true })
  items!: DriverDispatchResponse[];
}

export class MyIndependentProfileResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: IndependentDriverStatus })
  status!: IndependentDriverStatus;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  suspendedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({
    description:
      'true sólo si el perfil está APPROVED y el Driver no tiene ninguna asignación ACTIVE, sea de flotilla o independiente.',
  })
  canTakeServices!: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Asignación ACTIVE del Driver en cualquiera de los dos modelos, o null.',
  })
  activeAssignment!: Record<string, unknown> | null;
}
