import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServiceZoneStatus } from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

export class ServiceZoneSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'OCOZOCOAUTLA' }) code!: string;
  @ApiProperty({ example: 'Ocozocoautla de Espinosa, Chiapas, México' })
  name!: string;
  @ApiProperty({ enum: ServiceZoneStatus }) status!: ServiceZoneStatus;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ example: 16.735 }) minLatitude!: number;
  @ApiProperty({ example: 16.79 }) maxLatitude!: number;
  @ApiProperty({ example: -93.41 }) minLongitude!: number;
  @ApiProperty({ example: -93.34 }) maxLongitude!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class ServiceZoneResponse extends ServiceZoneSummaryResponse {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'GeoJSON Polygon/MultiPolygon normalizado.',
  })
  boundary!: Record<string, unknown>;
}
export class ServiceZonePageResponse extends PaginationResponse {
  @ApiProperty({ type: ServiceZoneSummaryResponse, isArray: true })
  items!: ServiceZoneSummaryResponse[];
}
