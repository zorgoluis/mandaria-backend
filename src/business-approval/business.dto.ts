import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class SubmitBusinessDto {
  @ApiProperty() @IsInt() @Min(1) expectedAccountRevision!: number;
  @ApiProperty({ maxLength: 160 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  businessName!: string;
  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  activity!: string;
  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;
  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  estimatedDeliveryVolume!: string;
  @ApiPropertyOptional({ maxLength: 1000 })
  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note?: string;
}
export class WithdrawBusinessDto {
  @ApiProperty() @IsInt() @Min(1) expectedApplicationRevision!: number;
}
export class DecisionBusinessDto extends WithdrawBusinessDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';
  @ApiProperty() @IsInt() @Min(1) expectedAccountRevision!: number;
  @ApiPropertyOptional({ maxLength: 500 })
  @ValidateIf(
    (o: DecisionBusinessDto, v) => o.decision === 'REJECT' || v !== undefined,
  )
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  publicReason?: string;
  @ApiPropertyOptional({ maxLength: 2000 })
  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  internalNote?: string;
}
export class RevokeBusinessDto {
  @ApiProperty() @IsUUID('4') grantId!: string;
  @ApiProperty() @IsInt() @Min(1) expectedAccountRevision!: number;
  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  publicReason!: string;
  @ApiPropertyOptional({ maxLength: 2000 })
  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  internalNote?: string;
}
export class AllowBusinessDto {
  @ApiProperty() @IsUUID('4') revokedGrantId!: string;
  @ApiProperty() @IsInt() @Min(1) expectedAccountRevision!: number;
  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  publicReason!: string;
  @ApiPropertyOptional({ maxLength: 2000 })
  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  internalNote?: string;
}
export class BusinessPageDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
  @ApiPropertyOptional({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'])
  status?: string;
}
export class AdminBusinessPageDto extends BusinessPageDto {
  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsUUID('4')
  customerAccountId?: string;
}
export class BusinessAttemptDto {
  @ApiProperty({ enum: ['SUBMIT', 'WITHDRAW', 'DOWNGRADE'] })
  @IsIn(['SUBMIT', 'WITHDRAW', 'DOWNGRADE'])
  operation!: 'SUBMIT' | 'WITHDRAW' | 'DOWNGRADE';
  @ApiPropertyOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsUUID('4')
  target?: string;
}
export class AdminBusinessAttemptDto {
  @ApiProperty({ enum: ['DECIDE', 'REVOKE', 'ALLOW_REAPPLICATION'] })
  @IsIn(['DECIDE', 'REVOKE', 'ALLOW_REAPPLICATION'])
  operation!: 'DECIDE' | 'REVOKE' | 'ALLOW_REAPPLICATION';
  @ApiProperty() @IsUUID('4') target!: string;
  @ApiProperty() @IsUUID('4') customerAccountId!: string;
}
