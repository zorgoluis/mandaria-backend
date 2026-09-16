import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { DriverAvailability, DriverStatus } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDriverDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'User existente, activo y con rol global DRIVER. No se crea ni se cambia el rol del usuario; un User sólo puede tener un perfil Driver.',
  })
  @IsUUID()
  userId!: string;
  @ApiProperty({
    description: 'Nombre operativo visible. Se recortan espacios exteriores.',
    example: 'Carlos',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
export class UpdateDriverDto {
  @ApiPropertyOptional({
    description: 'Nuevo nombre operativo.',
    example: 'Carlos Pérez',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
  @ApiPropertyOptional({
    enum: DriverStatus,
    description:
      'Estado administrativo. PENDING → ACTIVE/SUSPENDED, ACTIVE → SUSPENDED, SUSPENDED → ACTIVE; volver a PENDING devuelve 409. Salir de ACTIVE fuerza availability OFFLINE.',
    example: 'ACTIVE',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(DriverStatus)
  status?: DriverStatus;
}
export class DriverListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DriverStatus, description: 'Estado exacto.' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(DriverStatus)
  status?: DriverStatus;
  @ApiPropertyOptional({
    enum: DriverAvailability,
    description: 'Disponibilidad exacta.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(DriverAvailability)
  availability?: DriverAvailability;
  @ApiPropertyOptional({
    description:
      'Busca en nombre o email del User, sin distinguir mayúsculas y sólo dentro del proveedor.',
    example: 'carlos',
    maxLength: 100,
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;
}
const providerIdOption = {
  format: 'uuid',
  description:
    'Proveedor autorizado por membership. Puede omitirse sólo con exactamente una membership; nunca concede acceso por sí mismo.',
  example: '00000000-0000-4000-8000-000000000001',
} as const;
export class ProviderDriverListQueryDto extends DriverListQueryDto {
  @ApiPropertyOptional(providerIdOption)
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}
export class ProviderScopedPaginationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional(providerIdOption)
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}
export class AssignVehicleDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Vehicle ACTIVE, libre y del mismo proveedor que el Driver. Un vehículo de otro proveedor responde 404.',
  })
  @IsUUID()
  vehicleId!: string;
}
export class UpdateAvailabilityDto {
  @ApiProperty({
    enum: DriverAvailability,
    description:
      'OFFLINE siempre permitido. AVAILABLE/BUSY requieren Driver ACTIVE y proveedor ACTIVE. No acepta driverId: sólo modifica al Driver del JWT.',
    example: 'AVAILABLE',
  })
  @IsEnum(DriverAvailability)
  availability!: DriverAvailability;
}
