import type { SchemaObject } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
const text = { type: 'string', minLength: 1, maxLength: 150 } as const;
export const verificationDataSchemas: SchemaObject[] = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['fullName', 'contactPhone', 'operatingCity', 'documentType'],
    properties: {
      fullName: text,
      contactPhone: { type: 'string', minLength: 5, maxLength: 30 },
      operatingCity: text,
      documentType: { type: 'string', enum: ['INE'] },
      license: {
        type: 'object',
        additionalProperties: false,
        required: ['issuer', 'category', 'expiresAt', 'vehicleTypes'],
        properties: {
          issuer: text,
          category: text,
          expiresAt: { type: 'string', format: 'date-time' },
          vehicleTypes: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'string',
              enum: ['MOTORCYCLE', 'CAR', 'PICKUP', 'VAN', 'TRUCK'],
            },
          },
        },
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['declaredOwnerName', 'ownershipEvidenceType', 'serialNumber'],
    properties: {
      declaredOwnerName: text,
      serialNumber: text,
      ownershipEvidenceType: {
        type: 'string',
        enum: ['OWNED', 'RENTED', 'BORROWED'],
      },
      authorizationExpiresAt: { type: 'string', format: 'date-time' },
    },
  },
];
export class VerificationTermsResponse {
  @ApiProperty() version!: string;
  @ApiProperty({ enum: ['DRIVER', 'FLEET'] }) scope!: string;
  @ApiProperty({ enum: ['LOCAL_TEST'] }) environment!: string;
  @ApiProperty({
    description: 'Complete immutable test-only text; no contractual effect.',
  })
  text!: string;
  @ApiProperty() hash!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class VerificationAcceptanceResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['ACCEPTED'] }) status!: string;
  @ApiProperty({ enum: ['DRIVER', 'FLEET'] }) scope!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ format: 'date-time' }) acceptedAt!: string;
  @ApiProperty({ enum: ['LOCAL_TEST'] }) environment!: string;
  @ApiProperty({ enum: [false] }) contractuallyEffective!: boolean;
}
export class VerificationAttachmentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ enum: ['CREATED', 'VALIDATED', 'REMOVED'] }) status!: string;
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({ nullable: true, type: String }) mime!: string | null;
  @ApiProperty({ nullable: true, type: String }) hash!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class VerificationCaseResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty({ format: 'uuid' }) resourceId!: string;
  @ApiProperty({ enum: ['DRIVER_IDENTITY', 'VEHICLE'] }) subjectType!: string;
  @ApiProperty({
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  })
  status!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ enum: ['LOCAL_TEST'] }) environment!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Empty draft or strict identity/unit data, as defined by UpdateCaseDto.',
  })
  data!: object;
  @ApiProperty({
    type: 'object',
    properties: {
      providerId: { type: 'string', nullable: true, format: 'uuid' },
      independentProfileId: { type: 'string', nullable: true, format: 'uuid' },
    },
  })
  scope!: object;
  @ApiProperty({
    enum: ['NOT_SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'EXPIRED', 'REJECTED'],
  })
  verificationStatus!: string;
  @ApiProperty({ type: [VerificationAttachmentResponse] })
  attachments!: VerificationAttachmentResponse[];
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        kind: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  events!: object[];
  @ApiProperty({ nullable: true, type: String }) publicReason!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'SUPER_ADMIN only.',
  })
  internalNote?: string | null;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'SUPER_ADMIN only.',
  })
  reviewerId?: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  validUntil!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  licenseValidUntil!: string | null;
  @ApiProperty({ type: [String] }) licenseVehicleTypes!: string[];
}
export class VerificationUploadResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiPropertyOptional({
    description:
      'Private PUT URL, expires with expiresAt. Never persist in client recovery markers.',
  })
  uploadUrl?: string;
  @ApiPropertyOptional({ enum: ['application/octet-stream'] })
  contentType?: string;
}
export class VerificationAttemptResponse {
  @ApiProperty({ enum: ['ABSENT', 'APPLIED', 'CLOSED_NO_EFFECTS'] })
  state!: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Minimal historical command receipt. ABSENT does not prove failure.',
  })
  result?: object;
}
