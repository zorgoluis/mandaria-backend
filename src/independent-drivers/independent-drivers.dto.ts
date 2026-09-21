import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  IndependentDriverStatus,
  VehicleStatus,
  VehicleType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  INDEPENDENT_RELEASE_REASONS,
  RELEASE_DETAIL_MAX,
  RELEASE_DETAIL_MIN,
} from './independent-driver-policy.js';
import type { IndependentReleaseReason } from './independent-driver-policy.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const present = (_o: object, v: unknown) => v !== undefined && v !== null;
const IDENTIFIER = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const PLATE = /^[A-Z0-9][A-Z0-9 -]{0,14}$/;
const REASON_MIN = 3;
const REASON_MAX = 500;

const reasonProperty = {
  minLength: REASON_MIN,
  maxLength: REASON_MAX,
  description: `Motivo administrativo (${REASON_MIN}-${REASON_MAX} caracteres). Queda en el perfil y en la auditoría: no incluir datos personales.`,
} as const;

export class ApproveIndependentDriverDto {
  @ApiPropertyOptional(reasonProperty)
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  reason?: string;
}
export class CloseIndependentDriverDto {
  @ApiProperty(reasonProperty)
  @Transform(trim)
  @IsString()
  @MinLength(REASON_MIN)
  @MaxLength(REASON_MAX)
  reason!: string;
}
export class IndependentDriverListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: IndependentDriverStatus })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(IndependentDriverStatus)
  status?: IndependentDriverStatus;
}

class IndependentVehicleDetailsDto {
  @ApiPropertyOptional({ nullable: true, example: 'Italika', maxLength: 50 })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  brand?: string | null;
  @ApiPropertyOptional({ nullable: true, example: 'FT150', maxLength: 50 })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  model?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    example: 2023,
    minimum: 1900,
    maximum: 2100,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'Rojo', maxLength: 30 })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  color?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Placa opcional, normalizada a mayúsculas; null para bicicletas. No se valida unicidad ni formato oficial.',
    example: 'ABC-123',
    pattern: PLATE.source,
  })
  @Transform(upper)
  @ValidateIf(present)
  @Matches(PLATE)
  plate?: string | null;
}
export class CreateIndependentVehicleDto extends IndependentVehicleDetailsDto {
  @ApiProperty({
    description:
      'Identificador operativo único dentro de este repartidor independiente (no global). Se normaliza a mayúsculas.',
    example: 'MOTO-CARLOS-01',
    pattern: IDENTIFIER.source,
  })
  @Transform(upper)
  @Matches(IDENTIFIER)
  identifier!: string;
  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  type!: VehicleType;
}
export class UpdateIndependentVehicleDto extends IndependentVehicleDetailsDto {
  @ApiPropertyOptional({
    enum: VehicleStatus,
    description:
      'Desactivar un vehículo que está ejecutando un servicio responde 409 VEHICLE_HAS_ACTIVE_ASSIGNMENT.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}

export class TakeDispatchDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Vehículo propio del repartidor independiente: ACTIVE y sin otra asignación ACTIVE. Un vehículo de un proveedor o de otro repartidor responde 404; la pertenencia se relee en la base de datos, nunca se confía en el id enviado.',
  })
  @IsUUID()
  vehicleId!: string;
}
export class ReleaseDispatchDto {
  @ApiProperty({
    enum: INDEPENDENT_RELEASE_REASONS,
    description:
      'Motivo obligatorio por el que el repartidor abandona el servicio. No existe reasignación: liberar es la única salida.',
  })
  @IsIn(INDEPENDENT_RELEASE_REASONS)
  reason!: IndependentReleaseReason;
  @ApiPropertyOptional({
    minLength: RELEASE_DETAIL_MIN,
    maxLength: RELEASE_DETAIL_MAX,
    description: `Detalle opcional (${RELEASE_DETAIL_MIN}-${RELEASE_DETAIL_MAX} caracteres), obligatorio con OTHER. Queda en el historial: no incluir datos personales.`,
  })
  @Transform(trim)
  @ValidateIf(
    (o: ReleaseDispatchDto, v) => v !== undefined || o.reason === 'OTHER',
  )
  @IsString()
  @MinLength(RELEASE_DETAIL_MIN)
  @MaxLength(RELEASE_DETAIL_MAX)
  reasonDetail?: string;
}
