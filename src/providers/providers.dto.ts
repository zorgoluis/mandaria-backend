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
import {
  ProviderMemberRole,
  ProviderStatus,
  ProviderType,
} from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const code = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateProviderDto {
  @ApiProperty({
    description:
      'Nombre visible del proveedor. Se recortan espacios exteriores.',
    example: 'Rápidos de Coita',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
  @ApiProperty({
    description:
      'Código único; se normaliza a mayúsculas. Letras ASCII, números y guion bajo; comienza con letra.',
    example: 'RAPIDOS_COITA',
    pattern: '^[A-Z][A-Z0-9_]{1,49}$',
  })
  @Transform(code)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code!: string;
  @ApiProperty({
    enum: ProviderType,
    description:
      'FLEET: empresa/flotilla. INDEPENDENT: persona por cuenta propia; no es un vehículo.',
    example: 'FLEET',
  })
  @IsEnum(ProviderType)
  type!: ProviderType;
  @ApiPropertyOptional({
    description:
      'Límite operativo de repartidores. Si se omite, usa el default del tipo configurado en entorno.',
    minimum: 1,
    maximum: 10000,
    example: 10,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxDrivers?: number;
  @ApiPropertyOptional({
    description:
      'Límite operativo de vehículos. Se guarda en el proveedor; todavía no cuenta vehículos.',
    minimum: 1,
    maximum: 10000,
    example: 10,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxVehicles?: number;
}
export class UpdateProviderDto {
  @ApiPropertyOptional({
    description: 'Nuevo nombre visible; no puede quedar vacío.',
    example: 'Rápidos de Coita Centro',
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
    description: 'Nuevo código único, normalizado a mayúsculas.',
    example: 'RAPIDOS_COITA_CENTRO',
    pattern: '^[A-Z][A-Z0-9_]{1,49}$',
  })
  @Transform(code)
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code?: string;
  @ApiPropertyOptional({
    description: 'Nuevo límite. No aplica conteos de Driver en V1.2.',
    minimum: 1,
    maximum: 10000,
    example: 15,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxDrivers?: number;
  @ApiPropertyOptional({
    description: 'Nuevo límite. No aplica conteos de Vehicle en V1.2.',
    minimum: 1,
    maximum: 10000,
    example: 20,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxVehicles?: number;
}
export class ProviderListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ProviderType,
    description: 'Filtra por tipo exacto.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(ProviderType)
  type?: ProviderType;
  @ApiPropertyOptional({
    enum: ProviderStatus,
    description: 'Filtra por estado exacto.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(ProviderStatus)
  status?: ProviderStatus;
  @ApiPropertyOptional({
    description: 'Busca en nombre o código, sin distinguir mayúsculas.',
    example: 'rapidos',
    maxLength: 100,
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;
}
export class ProviderProfileQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Proveedor a consultar. Puede omitirse sólo si el usuario tiene exactamente una membership.',
    example: '00000000-0000-4000-8000-000000000001',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsUUID()
  providerId?: string;
}
export class AddProviderMemberDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'User existente, activo y con rol global PROVIDER_ADMIN. No se crea ni se cambia el rol del usuario.',
  })
  @IsUUID()
  userId!: string;
  @ApiProperty({
    enum: ProviderMemberRole,
    description:
      'Rol dentro de este proveedor, independiente de User.role. Ambos permiten sólo consulta en V1.2.',
    example: 'ADMIN',
  })
  @IsEnum(ProviderMemberRole)
  role!: ProviderMemberRole;
}
export class EmptyProviderActionDto {}
