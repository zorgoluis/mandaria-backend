import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
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
import { VehicleStatus, VehicleType } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
// undefined = keep; null = clear (only for optional descriptive fields).
const present = (_o: object, v: unknown) => v !== undefined && v !== null;
const IDENTIFIER = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const PLATE = /^[A-Z0-9][A-Z0-9 -]{0,14}$/;

class VehicleDetailsDto {
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
      'Placa opcional, normalizada a mayúsculas; null para bicicletas u otros vehículos sin placa. No se valida unicidad ni formato oficial.',
    example: 'ABC-123',
    pattern: PLATE.source,
  })
  @Transform(upper)
  @ValidateIf(present)
  @Matches(PLATE)
  plate?: string | null;
}
export class CreateVehicleDto extends VehicleDetailsDto {
  @ApiProperty({
    description:
      'Identificador operativo único dentro del proveedor (no global). Se normaliza a mayúsculas.',
    example: 'MOTO-01',
    pattern: IDENTIFIER.source,
  })
  @Transform(upper)
  @Matches(IDENTIFIER)
  identifier!: string;
  @ApiProperty({ enum: VehicleType, example: 'MOTORCYCLE' })
  @IsEnum(VehicleType)
  type!: VehicleType;
  @ApiPropertyOptional({
    enum: VehicleStatus,
    default: 'ACTIVE',
    description: 'Estado inicial; sólo ACTIVE es elegible para asignación.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}
export class UpdateVehicleDto extends VehicleDetailsDto {
  @ApiPropertyOptional({
    description: 'Nuevo identificador, único dentro del proveedor.',
    example: 'MOTO-02',
    pattern: IDENTIFIER.source,
  })
  @Transform(upper)
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(IDENTIFIER)
  identifier?: string;
  @ApiPropertyOptional({ enum: VehicleType })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleType)
  type?: VehicleType;
  @ApiPropertyOptional({
    enum: VehicleStatus,
    description:
      'Cualquier transición entre ACTIVE, INACTIVE, MAINTENANCE y SUSPENDED. Cambiar el estado no cierra la asignación vigente; sólo bloquea nuevas asignaciones.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}
export class VehicleListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VehicleType, description: 'Tipo exacto.' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleType)
  type?: VehicleType;
  @ApiPropertyOptional({ enum: VehicleStatus, description: 'Estado exacto.' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
  @ApiPropertyOptional({
    description:
      'Busca en identifier, placa, marca o modelo, sin distinguir mayúsculas.',
    example: 'moto',
    maxLength: 100,
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;
}
export class ProviderVehicleListQueryDto extends VehicleListQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Proveedor autorizado por membership. Puede omitirse sólo con exactamente una membership; nunca concede acceso por sí mismo.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}
