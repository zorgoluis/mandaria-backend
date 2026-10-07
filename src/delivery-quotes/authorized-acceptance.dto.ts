import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsOptional,
  IsDateString,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class CustomerAuthorizationDto {
  @ApiProperty({
    enum: [1, 2],
    description:
      'B2B REQUESTER exige versión 2 y hash/versión de términos. Versión 1 conserva RECIPIENT histórico. Cliente directo exige términos exactos en ambas versiones.',
  })
  @IsIn([1, 2])
  version!: number;
  @ApiPropertyOptional({ enum: [1] })
  @IsOptional()
  @Equals(1)
  shippingTermsVersion?: number;
  @ApiPropertyOptional({ pattern: '^[a-f0-9]{64}$' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  shippingTermsHash?: string;
  @ApiProperty({ enum: ['AUTHORIZED_BY_CUSTOMER'] })
  @Equals('AUTHORIZED_BY_CUSTOMER')
  status!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description:
      'Referencia opaca de evidencia conservada por el integrador; sin PII ni comprobantes. Mandaria no verifica directamente el consentimiento humano.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'Posterior a la creación de MQ; zona explícita. No amplía TTL.',
  })
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  authorizedAt!: string;
  @ApiProperty({ example: 'MQ-000101' })
  @Matches(/^MQ-\d{6,12}$/)
  quotePublicId!: string;
  @ApiProperty({
    example: '25.00',
    description: 'Eco exacto del snapshot; nunca determina el precio.',
  })
  @Matches(/^\d{1,12}\.\d{2}$/)
  amount!: string;
  @ApiProperty({ enum: ['MXN'] }) @Equals('MXN') currency!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Vencimiento exacto de MQ, sin renovación.',
  })
  @IsDateString({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  expiresAt!: string;
}
export class AcceptDeliveryQuoteDto {
  @ApiPropertyOptional({
    type: CustomerAuthorizationDto,
    description:
      'Obligatorio para MQ convertidas y nuevas solicitudes REQUESTER. Para REQUESTER B2B usar versión 2 con shippingTermsVersion y shippingTermsHash exactos. No convertidas RECIPIENT conservan body vacío; allí una atestación se rechaza.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAuthorizationDto)
  customerAuthorization?: CustomerAuthorizationDto;
}
