import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { CUSTODY_REASONS, EXECUTION_PHASES } from './execution.types.js';
import type { ExecutionPhase } from './execution.types.js';
import { PaginationQueryDto } from '../common/pagination.dto.js';
export class ProviderExecutionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class IncidentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'RESOLVED'], default: 'OPEN' })
  @IsIn(['OPEN', 'RESOLVED'])
  status: 'OPEN' | 'RESOLVED' = 'OPEN';
}
export class TransferCandidatesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['FLEET', 'INDEPENDENT'], default: 'FLEET' })
  @IsIn(['FLEET', 'INDEPENDENT'])
  mode: 'FLEET' | 'INDEPENDENT' = 'FLEET';
}

export class ExecutionCommandDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() assignmentId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedRevision!: number;
}
export class DriverAttemptParamsDto {
  @ApiProperty({ enum: ['ADVANCE', 'REPORT', 'DELIVER'] })
  @IsIn(['ADVANCE', 'REPORT', 'DELIVER'])
  operation!: 'ADVANCE' | 'REPORT' | 'DELIVER';
}
export class AdvanceExecutionDto extends ExecutionCommandDto {
  @ApiProperty({ enum: EXECUTION_PHASES })
  @IsIn(EXECUTION_PHASES)
  phase!: ExecutionPhase;
}
export class ReportCustodyIncidentDto extends ExecutionCommandDto {
  @ApiProperty({ enum: CUSTODY_REASONS })
  @IsIn(CUSTODY_REASONS)
  reasonCode!: string;
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  reasonDetail!: string;
}
export class CustodyRecipientDto {
  @ApiProperty({ enum: ['FLEET', 'INDEPENDENT'] })
  @IsIn(['FLEET', 'INDEPENDENT'])
  mode!: 'FLEET' | 'INDEPENDENT';
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() driverId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() vehicleId!: string;
}
/** Conditional required fields are also checked by the service before any mutation. */
export class ResolveCustodyIncidentDto extends ExecutionCommandDto {
  @ApiProperty({ enum: ['RETURN_TO_ORIGIN', 'TRANSFER'] })
  @IsIn(['RETURN_TO_ORIGIN', 'TRANSFER'])
  type!: 'RETURN_TO_ORIGIN' | 'TRANSFER';
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  reason!: string;
  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  occurredAt!: string;
  @ApiProperty({ enum: ['PHONE'] })
  @Equals('PHONE')
  confirmationMethod!: 'PHONE';
  @ApiPropertyOptional({ type: CustodyRecipientDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustodyRecipientDto)
  recipient?: CustodyRecipientDto;
  @ApiPropertyOptional() @IsOptional() @Equals(true) custodianConfirmed?: true;
  @ApiPropertyOptional() @IsOptional() @Equals(true) originConfirmed?: true;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  originContactLabel?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  originContactRole?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Equals(true)
  releasingCustodianConfirmed?: true;
  @ApiPropertyOptional()
  @IsOptional()
  @Equals(true)
  receivingCustodianConfirmed?: true;
  @ApiPropertyOptional()
  @IsOptional()
  @Equals(true)
  atCurrentStageLocation?: true;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  recipientProviderAdminUserId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Equals(true)
  recipientProviderAdminConfirmed?: true;
}
