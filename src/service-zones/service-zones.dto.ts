import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ServiceZoneStatus } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
export const CURRENCIES = Intl.supportedValuesOf('currency');
const boundaryDoc = {
  type: 'object',
  description:
    'GeoJSON Polygon o MultiPolygon en orden [longitude, latitude]; anillos cerrados, sin autointersecciones, huecos permitidos. Los puntos sobre el borde cuentan como dentro. Máximo 10000 posiciones.',
  example: {
    type: 'Polygon',
    coordinates: [
      [
        [-93.41, 16.735],
        [-93.34, 16.735],
        [-93.34, 16.79],
        [-93.41, 16.79],
        [-93.41, 16.735],
      ],
    ],
  },
  additionalProperties: true,
} as const;

export class CreateServiceZoneDto {
  @ApiProperty({ example: 'OCOZOCOAUTLA', pattern: '^[A-Z][A-Z0-9_]{1,49}$' })
  @Transform(upper)
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code!: string;
  @ApiProperty({
    example: 'Ocozocoautla de Espinosa, Chiapas, México',
    maxLength: 100,
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
  @ApiProperty({
    example: 'MXN',
    description: 'ISO 4217; inmutable. Los RatePlans usan esta moneda.',
  })
  @Transform(upper)
  @IsIn(CURRENCIES, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
  @ApiProperty(boundaryDoc)
  @IsObject()
  boundary!: Record<string, unknown>;
}
export class UpdateServiceZoneDto {
  @ApiProperty({ example: 'Ocozocoautla, Chiapas', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
export class ReplaceBoundaryDto {
  @ApiProperty(boundaryDoc)
  @IsObject()
  boundary!: Record<string, unknown>;
}
export class ServiceZoneListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ServiceZoneStatus })
  @ValidateIf((_o, v) => v !== undefined)
  @IsEnum(ServiceZoneStatus)
  status?: ServiceZoneStatus;
  @ApiPropertyOptional({
    description: 'Busca en código o nombre.',
    example: 'ocoz',
  })
  @Transform(trim)
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;
}
