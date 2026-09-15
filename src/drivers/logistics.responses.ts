import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DriverAvailability,
  DriverStatus,
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
  @ApiPropertyOptional({ nullable: true, example: 'Italika' })
  brand!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'FT150' })
  model!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 2023 }) year!: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'Rojo' })
  color!: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'ABC-123' })
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
  @ApiPropertyOptional({ nullable: true }) brand!: string | null;
  @ApiPropertyOptional({ nullable: true }) model!: string | null;
  @ApiPropertyOptional({ nullable: true }) year!: number | null;
  @ApiPropertyOptional({ nullable: true }) color!: string | null;
  @ApiPropertyOptional({ nullable: true }) plate!: string | null;
}
class DriverSelfAssignmentResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(dateTime) assignedAt!: Date;
  @ApiProperty({ type: DriverSelfVehicleResponse })
  vehicle!: DriverSelfVehicleResponse;
}
export class DriverSelfResponse {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Carlos' }) name!: string;
  @ApiProperty({ enum: DriverStatus }) status!: DriverStatus;
  @ApiProperty({ enum: DriverAvailability }) availability!: DriverAvailability;
  @ApiProperty({ type: DriverSelfProviderResponse })
  provider!: DriverSelfProviderResponse;
  @ApiProperty({ type: DriverSelfAssignmentResponse, nullable: true })
  currentAssignment!: DriverSelfAssignmentResponse | null;
}
