import { ApiProperty } from '@nestjs/swagger';
import {
  ProviderMemberRole,
  ProviderStatus,
  ProviderType,
  Role,
} from '@prisma/client';

export class ProviderResponse {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000001',
  })
  id!: string;
  @ApiProperty({ example: 'Rápidos de Coita' }) name!: string;
  @ApiProperty({ example: 'RAPIDOS_COITA' }) code!: string;
  @ApiProperty({ enum: ProviderType, example: 'FLEET' }) type!: ProviderType;
  @ApiProperty({
    enum: ProviderStatus,
    example: 'PENDING',
    description: 'Estado administrativo; no elimina el proveedor.',
  })
  status!: ProviderStatus;
  @ApiProperty({
    minimum: 1,
    maximum: 10000,
    example: 10,
    description: 'Capacidad administrativa; no cuenta Drivers en V1.2.',
  })
  maxDrivers!: number;
  @ApiProperty({
    minimum: 1,
    maximum: 10000,
    example: 10,
    description: 'Capacidad administrativa; no cuenta Vehicles en V1.2.',
  })
  maxVehicles!: number;
  @ApiProperty({ format: 'date-time', example: '2026-09-15T12:00:00.000Z' })
  createdAt!: Date;
  @ApiProperty({ format: 'date-time', example: '2026-09-15T12:00:00.000Z' })
  updatedAt!: Date;
}
export class ProviderLimitsResponse {
  @ApiProperty({ example: 10, minimum: 1, maximum: 10000 }) maxDrivers!: number;
  @ApiProperty({ example: 10, minimum: 1, maximum: 10000 })
  maxVehicles!: number;
}
export class ProviderProfileResponse {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-4000-8000-000000000001',
  })
  id!: string;
  @ApiProperty({ example: 'Rápidos de Coita' }) name!: string;
  @ApiProperty({ example: 'RAPIDOS_COITA' }) code!: string;
  @ApiProperty({ enum: ProviderType, example: 'FLEET' }) type!: ProviderType;
  @ApiProperty({ enum: ProviderStatus, example: 'ACTIVE' })
  status!: ProviderStatus;
  @ApiProperty({ type: ProviderLimitsResponse })
  limits!: ProviderLimitsResponse;
  @ApiProperty({
    enum: ProviderMemberRole,
    example: 'ADMIN',
    description: 'Rol local de quien consulta. No sustituye User.role.',
  })
  membershipRole!: ProviderMemberRole;
}
export class PaginationResponse {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) pageSize!: number;
  @ApiProperty({ example: 1 }) total!: number;
  @ApiProperty({ example: 1, description: 'Cero cuando no hay resultados.' })
  totalPages!: number;
}
export class ProviderUsageItemResponse {
  @ApiProperty({
    example: 3,
    description:
      'Registros existentes en cualquier estado (PENDING/SUSPENDED/INACTIVE incluidos).',
  })
  count!: number;
  @ApiProperty({ example: 10 }) max!: number;
}
export class ProviderUsageResponse {
  @ApiProperty({ type: ProviderUsageItemResponse })
  drivers!: ProviderUsageItemResponse;
  @ApiProperty({ type: ProviderUsageItemResponse })
  vehicles!: ProviderUsageItemResponse;
}
export class ProviderListItemResponse extends ProviderResponse {
  @ApiProperty({
    type: ProviderUsageResponse,
    description:
      'Conteos calculados en la misma consulta del listado (sin N+1).',
  })
  usage!: ProviderUsageResponse;
}
export class ProviderPageResponse extends PaginationResponse {
  @ApiProperty({ type: ProviderListItemResponse, isArray: true })
  items!: ProviderListItemResponse[];
}
export class ProviderCapacityResponse extends ProviderUsageResponse {
  @ApiProperty({ format: 'uuid' }) providerId!: string;
}
export class ProviderProfilePageResponse extends PaginationResponse {
  @ApiProperty({ type: ProviderProfileResponse, isArray: true })
  items!: ProviderProfileResponse[];
}
export class ProviderMemberUserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    example: 'admin@example.test',
    description: 'Email del User existente; nunca se devuelve passwordHash.',
  })
  email!: string;
  @ApiProperty({ enum: Role, description: 'Rol global actual del usuario.' })
  role!: Role;
  @ApiProperty({ example: true }) active!: boolean;
}
export class ProviderMemberResponse {
  @ApiProperty({
    format: 'uuid',
    description: 'Membership ID; usarlo para retirar esta relación.',
  })
  id!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ProviderMemberRole, example: 'ADMIN' })
  role!: ProviderMemberRole;
  @ApiProperty({ type: ProviderMemberUserResponse })
  user!: ProviderMemberUserResponse;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class ProviderMemberPageResponse extends PaginationResponse {
  @ApiProperty({ type: ProviderMemberResponse, isArray: true })
  items!: ProviderMemberResponse[];
}
