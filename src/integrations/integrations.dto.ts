import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IntegrationStatus } from '@prisma/client';
import { INTEGRATION_SCOPES } from './integration-scopes.js';

export class CreateIntegrationDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ example: 'COITA_EATS' })
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code!: string;
}
export class UpdateIntegrationDto {
  // Compatibility for V1.0 administrative callers; storage uses SUSPENDED.
  @Transform(({ value }: { value: unknown }) =>
    value === 'INACTIVE' ? 'SUSPENDED' : value,
  )
  @ApiProperty({ enum: IntegrationStatus })
  @IsEnum(IntegrationStatus)
  status!: IntegrationStatus;
}
export class CreateCredentialDto {
  @ApiPropertyOptional({ enum: INTEGRATION_SCOPES, isArray: true, default: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(INTEGRATION_SCOPES.length)
  @IsIn(INTEGRATION_SCOPES, { each: true })
  scopes?: string[];
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Expiration in the future; omitted means no credential expiry',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
export class IntegrationTokenDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Public credential identifier, not the IntegrationClient entity ID',
  })
  @IsUUID('4')
  clientId!: string;
  @ApiProperty({
    writeOnly: true,
    description: 'Secret returned once on credential creation or rotation',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  clientSecret!: string;
}
export class IntegrationTokenResponse {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: 3600 }) expiresIn!: number;
}
export class IntegrationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: IntegrationStatus }) status!: IntegrationStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class IntegrationMeResponse extends IntegrationResponse {
  @ApiProperty({ enum: INTEGRATION_SCOPES, isArray: true }) scopes!: string[];
}
export class CredentialResponse {
  @ApiProperty({
    format: 'uuid',
    description: 'Credential ID; use this as clientId at /integrations/token',
  })
  id!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Owning IntegrationClient ID (database relation)',
  })
  clientId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'REVOKED'] }) status!: string;
  @ApiProperty({ enum: INTEGRATION_SCOPES, isArray: true }) scopes!: string[];
  @ApiProperty({ nullable: true, format: 'date-time' }) expiresAt!: Date | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) revokedAt!: Date | null;
  @ApiProperty({ nullable: true, format: 'date-time' })
  lastUsedAt!: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class CredentialCreatedResponse {
  @ApiProperty({
    format: 'uuid',
    description: 'Public credential identifier for token exchange',
  })
  clientId!: string;
  @ApiProperty({ format: 'uuid' }) integrationId!: string;
  @ApiProperty({
    description: 'Returned only once. Store securely in the consuming backend.',
  })
  clientSecret!: string;
}
export class IntegrationListResponse extends IntegrationResponse {
  @ApiProperty({
    type: CredentialResponse,
    isArray: true,
    description: 'Up to 100 credential metadata records; no secrets',
  })
  credentials!: CredentialResponse[];
}
