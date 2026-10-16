import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../common/password-policy.js';
import { verificationDataSchemas } from './verification.responses.js';
import { OmitType } from '@nestjs/swagger';
import { CreateVehicleDto } from '../vehicles/vehicles.dto.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  Equals,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { CATEGORIES } from './verification-rules.js';
export class RegistrationDto {
  @ApiProperty({ format: 'email' }) @IsEmail() @MaxLength(254) email!: string;
}
export class RegistrationConfirmDto {
  @ApiProperty({ writeOnly: true }) @IsString() @Length(43, 128) token!: string;
  @ApiProperty({
    writeOnly: true,
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  password!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @Length(1, 100) name!: string;
}
export class TermsQueryDto {
  @ApiProperty({ enum: ['DRIVER', 'FLEET'] })
  @IsIn(['DRIVER', 'FLEET'])
  scope!: 'DRIVER' | 'FLEET';
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}
export class AcceptTermsDto extends TermsQueryDto {
  @ApiProperty() @IsString() @Length(1, 100) version!: string;
  @ApiProperty({ minLength: 64, maxLength: 64 })
  @IsString()
  @Length(64, 64)
  hash!: string;
  @ApiProperty({ enum: [true] }) @Equals(true) accepted!: true;
  @ApiProperty({ enum: ['WEB_CHECKBOX_BUTTON'] })
  @Equals('WEB_CHECKBOX_BUTTON')
  method!: 'WEB_CHECKBOX_BUTTON';
}
export class CreateCaseDto {
  @ApiProperty({ enum: ['DRIVER_IDENTITY', 'VEHICLE'] })
  @IsIn(['DRIVER_IDENTITY', 'VEHICLE'])
  subjectType!: 'DRIVER_IDENTITY' | 'VEHICLE';
  @ApiProperty({ format: 'uuid' }) @IsUUID() subjectId!: string;
}
export class RevisionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedVersion!: number;
}
export class UpdateCaseDto extends RevisionDto {
  @ApiProperty({
    oneOf: verificationDataSchemas,
    description:
      'Identity: fullName/contactPhone/operatingCity/documentType=INE and optional license. Unit: declaredOwnerName/serialNumber/ownershipEvidenceType OWNED|RENTED|BORROWED, optional authorizationExpiresAt. Strict server validation; see requirements.',
  })
  @IsObject()
  data!: Record<string, unknown>;
}
export class UploadDto extends RevisionDto {
  @ApiProperty({ enum: CATEGORIES })
  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];
}
export class DecisionDto extends RevisionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';
  @ApiProperty({ enum: ['LOCAL-TEST-1'] })
  @Equals('LOCAL-TEST-1')
  checklistVersion!: string;
  @ApiProperty({
    type: [String],
    description:
      'Exact required checklist codes, all manually confirmed PASS. See requirements.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  passedChecks!: string[];
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  publicReason?: string;
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNote?: string;
}
export class OnboardingVehicleDto extends OmitType(CreateVehicleDto, [
  'status',
] as const) {}
export class VerificationListDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  })
  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'])
  status?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;
}
export class AttemptDto {
  @ApiProperty({
    description: 'Exact operation returned by the command contract.',
  })
  @IsString()
  @Length(1, 60)
  operation!: string;
  @ApiProperty({
    description:
      'Case/resource UUID, or DRIVER/FLEET:providerId for terms, or POLICY/SELF.',
  })
  @IsString()
  @Length(1, 100)
  target!: string;
}
export class PolicyDto extends RevisionDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
}
export class ReceiptDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() revision?: number;
}

export class VerificationEmailConfirmDto {
  @ApiProperty({ writeOnly: true }) @IsString() @Length(43, 128) token!: string;
}
