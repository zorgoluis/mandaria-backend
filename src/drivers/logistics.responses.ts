import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DeliveryAssignmentMode,
  DriverAvailability,
  DriverStatus,
  IndependentDriverStatus,
  ProviderStatus,
  ProviderType,
  Role,
  VehicleStatus,
  VehicleType,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

const uuid = { format: 'uuid' } as const;
const dateTime = { format: 'date-time' } as const;

export class VehicleSummaryResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'MOTO-01' }) identifier!: string;
  @ApiProperty({ enum: VehicleType, example: 'MOTORCYCLE' }) type!: VehicleType;
  @ApiProperty({ enum: VehicleStatus, example: 'ACTIVE' })
  status!: VehicleStatus;
}
export class DriverSummaryResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
  @ApiProperty({ enum: DriverStatus, example: 'ACTIVE' }) status!: DriverStatus;
  @ApiProperty({ enum: DriverAvailability, example: 'OFFLINE' })
  availability!: DriverAvailability;
}
export class DriverCurrentAssignmentResponse {
  @ApiProperty({ ...uuid, description: 'DriverVehicleAssignment.id' })
  id!: string;
  @ApiProperty(dateTime) assignedAt!: Date;
  @ApiProperty({ type: VehicleSummaryResponse })
  vehicle!: VehicleSummaryResponse;
}
export class VehicleCurrentAssignmentResponse {
  @ApiProperty({ ...uuid, description: 'DriverVehicleAssignment.id' })
  id!: string;
  @ApiProperty(dateTime) assignedAt!: Date;
  @ApiProperty({ type: DriverSummaryResponse })
  driver!: DriverSummaryResponse;
}
export class DriverUserResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'carlos@example.test' }) email!: string;
  @ApiProperty({ enum: Role, example: 'DRIVER' }) role!: Role;
  @ApiProperty({ example: true }) active!: boolean;
}
export class DriverResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty({ ...uuid, description: 'User que autentica al Driver.' })
  userId!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
  @ApiProperty({
    enum: DriverStatus,
    example: 'PENDING',
    description: 'Estado administrativo.',
  })
  status!: DriverStatus;
  @ApiProperty({
    enum: DriverAvailability,
    example: 'OFFLINE',
    description: 'Disponibilidad declarada; independiente del estado.',
  })
  availability!: DriverAvailability;
  @ApiProperty({
    type: DriverUserResponse,
    description: 'Nunca incluye passwordHash ni tokens.',
  })
  user!: DriverUserResponse;
  @ApiProperty({ type: DriverCurrentAssignmentResponse, nullable: true })
  currentAssignment!: DriverCurrentAssignmentResponse | null;
  @ApiProperty(dateTime) createdAt!: Date;
  @ApiProperty(dateTime) updatedAt!: Date;
}
export class DriverPageResponse extends PaginationResponse {
  @ApiProperty({ type: DriverResponse, isArray: true })
  items!: DriverResponse[];
}
export class VehicleResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty({ example: 'MOTO-01' }) identifier!: string;
  @ApiProperty({ enum: VehicleType, example: 'MOTORCYCLE' }) type!: VehicleType;
  @ApiProperty({ enum: VehicleStatus, example: 'ACTIVE' })
  status!: VehicleStatus;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Italika' })
  brand!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'FT150' })
  model!: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true, example: 2023 })
  year!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Rojo' })
  color!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'ABC-123' })
  plate!: string | null;
  @ApiProperty({ type: VehicleCurrentAssignmentResponse, nullable: true })
  currentAssignment!: VehicleCurrentAssignmentResponse | null;
  @ApiProperty(dateTime) createdAt!: Date;
  @ApiProperty(dateTime) updatedAt!: Date;
}
export class VehiclePageResponse extends PaginationResponse {
  @ApiProperty({ type: VehicleResponse, isArray: true })
  items!: VehicleResponse[];
}
class AssignmentDriverResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
}
class AssignmentVehicleResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'MOTO-01' }) identifier!: string;
  @ApiProperty({ enum: VehicleType }) type!: VehicleType;
}
export class AssignmentResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty(uuid) driverId!: string;
  @ApiProperty(uuid) vehicleId!: string;
  @ApiProperty(dateTime) assignedAt!: Date;
  @ApiProperty({
    type: String,
    ...dateTime,
    nullable: true,
    description: 'null mientras la asignación está vigente.',
  })
  unassignedAt!: Date | null;
  @ApiProperty({ type: AssignmentDriverResponse })
  driver!: AssignmentDriverResponse;
  @ApiProperty({ type: AssignmentVehicleResponse })
  vehicle!: AssignmentVehicleResponse;
}
export class AssignmentPageResponse extends PaginationResponse {
  @ApiProperty({ type: AssignmentResponse, isArray: true })
  items!: AssignmentResponse[];
}
class DriverSelfProviderResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Rápidos de Coita' }) name!: string;
  @ApiProperty({ example: 'RAPIDOS_COITA' }) code!: string;
  @ApiProperty({ enum: ProviderType }) type!: ProviderType;
  @ApiProperty({ enum: ProviderStatus }) status!: ProviderStatus;
}
class DriverSelfVehicleResponse extends VehicleSummaryResponse {
  @ApiPropertyOptional({ type: String, nullable: true }) brand!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) model!: string | null;
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  year!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) color!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) plate!: string | null;
}
class DriverSelfAssignmentResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(dateTime) assignedAt!: Date;
  @ApiProperty({ type: DriverSelfVehicleResponse })
  vehicle!: DriverSelfVehicleResponse;
}
class DriverSelfIndependentResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({
    enum: IndependentDriverStatus,
    description:
      'APPROVED habilita /driver/dispatches/available y /driver/dispatches/:id/take. Cualquier otro estado los rechaza con 409 INDEPENDENT_NOT_APPROVED.',
  })
  status!: IndependentDriverStatus;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  suspendedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({
    description:
      'true sólo si el perfil está APPROVED y no hay ninguna asignación de entrega ACTIVE, sea de flotilla o independiente: un repartidor ejecuta un servicio a la vez en cualquiera de los dos modelos.',
  })
  canTakeServices!: boolean;
}
/** Exactly the three fields drivers.service selects; there is no assignedAt here. */
export class DriverSelfActiveDeliveryAssignmentResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ enum: DeliveryAssignmentMode })
  mode!: DeliveryAssignmentMode;
  @ApiProperty(uuid) dispatchId!: string;
}
export class DriverSelfResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
  @ApiProperty({ enum: DriverStatus }) status!: DriverStatus;
  @ApiProperty({ enum: DriverAvailability }) availability!: DriverAvailability;
  @ApiProperty({ type: DriverSelfProviderResponse })
  provider!: DriverSelfProviderResponse;
  @ApiProperty({
    type: DriverSelfAssignmentResponse,
    nullable: true,
    description:
      'Emparejamiento Driver↔Vehicle V1.4 con el vehículo del proveedor. No describe los vehículos propios del repartidor independiente: ésos están en GET /driver/vehicles.',
  })
  currentAssignment!: DriverSelfAssignmentResponse | null;
  @ApiPropertyOptional({
    type: DriverSelfActiveDeliveryAssignmentResponse,
    nullable: true,
    description:
      'V1.9: asignación de entrega ACTIVE del repartidor en cualquiera de los dos modelos (con su mode y dispatchId), o null si está libre.',
  })
  activeDeliveryAssignment!: DriverSelfActiveDeliveryAssignmentResponse | null;
  @ApiPropertyOptional({
    type: DriverSelfIndependentResponse,
    nullable: true,
    description:
      'V1.9: capacidad de operar por cuenta propia. null si Mandaria no lo ha habilitado como independiente; ser repartidor de un proveedor no la otorga.',
  })
  independent!: DriverSelfIndependentResponse | null;
}
