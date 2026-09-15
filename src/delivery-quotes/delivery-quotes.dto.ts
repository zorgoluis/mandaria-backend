import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsUUID,
  Matches,
  ValidateIf,
} from 'class-validator';
import { DeliveryQuoteStatus } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';

export const QUOTE_PUBLIC_ID = /^MQ-\d{6,}$/;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
const defined = (_o: object, v: unknown) => v !== undefined;

export class DeliveryQuoteListQueryDto extends PaginationQueryDto {}
export class AdminDeliveryQuoteListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'MQ-000001' })
  @Transform(upper)
  @ValidateIf(defined)
  @Matches(QUOTE_PUBLIC_ID)
  publicId?: string;
  @ApiPropertyOptional({ example: 'MDR-000001' })
  @Transform(upper)
  @ValidateIf(defined)
  @Matches(/^MDR-\d{6,}$/)
  deliveryRequestPublicId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf(defined)
  @IsUUID()
  integrationClientId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf(defined)
  @IsUUID()
  serviceZoneId?: string;
  @ApiPropertyOptional({
    enum: DeliveryQuoteStatus,
    description:
      'Estado efectivo: OFFERED excluye las vencidas; EXPIRED incluye OFFERED con expiresAt pasado.',
  })
  @ValidateIf(defined)
  @IsEnum(DeliveryQuoteStatus)
  status?: DeliveryQuoteStatus;
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf(defined)
  @IsDateString({ strict: true })
  createdFrom?: string;
  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf(defined)
  @IsDateString({ strict: true })
  createdTo?: string;
}
