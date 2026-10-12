import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { CustomerType } from '@prisma/client';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class CustomerEmailDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
export class CustomerProfileDto {
  @ApiProperty({ enum: ['PERSONAL', 'BUSINESS'] })
  @IsIn(['PERSONAL', 'BUSINESS'])
  type!: CustomerType;
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;
  @ApiPropertyOptional()
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  businessName?: string;
}
export class RegisterCustomerDto extends CustomerEmailDto {
  @ApiProperty({ enum: ['PERSONAL', 'BUSINESS'] })
  @IsIn(['PERSONAL', 'BUSINESS'])
  type!: CustomerType;
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;
  @ApiPropertyOptional()
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  businessName?: string;
}
export class CustomerTokenDto {
  @ApiProperty() @IsString() @MinLength(32) @MaxLength(200) token!: string;
}
export class CustomerConfirmDto extends CustomerTokenDto {
  @ApiProperty({ minLength: 16, maxLength: 128 })
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  password!: string;
}
export class UpdateCustomerDto {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
  @ApiPropertyOptional()
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;
  @ApiPropertyOptional()
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  businessName?: string;
}

export class CustomerAcceptedDto {
  @ApiProperty({ enum: ['ACCEPTED'] }) status!: 'ACCEPTED';
}
export class ChangeCustomerTypeDto {
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
  @ApiProperty({ enum: ['PERSONAL', 'BUSINESS'] })
  @IsIn(['PERSONAL', 'BUSINESS'])
  type!: CustomerType;
}
export class CustomerConfirmedDto {
  @ApiPropertyOptional({
    enum: ['PERSONAL'],
    description: 'Present only for REGISTER',
  })
  profileType?: 'PERSONAL';
  @ApiPropertyOptional({
    description:
      'Present only for REGISTER; historical BUSINESS token requires application',
  })
  businessApplicationRequired?: boolean;
  @ApiProperty({ enum: ['CONFIRMED'] }) status!: 'CONFIRMED';
}
export class CustomerProfileViewDto {
  @ApiProperty({ format: 'uuid' }) customerAccountId!: string;
  @ApiProperty({
    type: 'object',
    required: [
      'state',
      'source',
      'restrictionReason',
      'canApply',
      'canDowngrade',
      'reapplicationBlocked',
    ],
    properties: {
      state: {
        type: 'string',
        enum: ['NONE', 'REVIEW_REQUIRED', 'ACTIVE', 'RESTRICTED'],
      },
      source: { type: 'string', nullable: true },
      restrictionReason: { type: 'string', nullable: true },
      canApply: { type: 'boolean' },
      canDowngrade: { type: 'boolean' },
      reapplicationBlocked: { type: 'boolean' },
    },
  })
  businessAccess!: object;
  @ApiProperty({
    type: 'object',
    nullable: true,
    required: ['id', 'status', 'revision'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: {
        type: 'string',
        enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
      },
      revision: { type: 'integer' },
    },
  })
  businessApplication!: object | null;
  @ApiProperty({ enum: ['PERSONAL', 'BUSINESS'] }) type!: CustomerType;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: String, nullable: true }) businessName!: string | null;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty() active!: boolean;
}
