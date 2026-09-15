import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RateCalculationType,
  RatePlanStatus,
  ServiceType,
  ServiceZoneStatus,
} from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';

export class RateBandResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 2000, description: 'Inclusivo (m).' })
  minDistanceMeters!: number;
  @ApiProperty({ example: 4000, description: 'Exclusivo (m).' })
  maxDistanceMeters!: number;
  @ApiProperty({ example: '40.00', type: 'string' }) amount!: string;
  @ApiProperty({ example: 'MXN' }) currency!: string;
}
class RatePlanZoneResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'OCOZOCOAUTLA' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ServiceZoneStatus }) status!: ServiceZoneStatus;
}
export class RatePlanResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) serviceZoneId!: string;
  @ApiProperty({ enum: ServiceType }) serviceType!: ServiceType;
  @ApiProperty({ example: 3 }) version!: number;
  @ApiProperty({
    enum: RatePlanStatus,
    description: 'DRAFT editable → ACTIVE → INACTIVE (histórico inmutable).',
  })
  status!: RatePlanStatus;
  @ApiProperty({ enum: RateCalculationType })
  calculationType!: RateCalculationType;
  @ApiProperty({ example: 15 }) quoteValidityMinutes!: number;
  @ApiProperty({ example: 'MXN' }) currency!: string;
  @ApiProperty({ type: RatePlanZoneResponse })
  serviceZone!: RatePlanZoneResponse;
  @ApiProperty({ type: RateBandResponse, isArray: true })
  bands!: RateBandResponse[];
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  activatedAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  deactivatedAt!: Date | null;
}
export class RatePlanPageResponse extends PaginationResponse {
  @ApiProperty({ type: RatePlanResponse, isArray: true })
  items!: RatePlanResponse[];
}
export class RatePlanValidationResponse {
  @ApiProperty({ format: 'uuid' }) ratePlanId!: string;
  @ApiProperty() valid!: boolean;
  @ApiProperty({
    type: 'string',
    isArray: true,
    example: ['gap between 4000 and 5000 meters'],
  })
  errors!: string[];
}
