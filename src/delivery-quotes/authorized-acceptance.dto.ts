import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Equals,
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
  @ApiProperty({ enum: [1] }) @Equals(1) version!: number;
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
      'Obligatorio sólo para MQ convertidas. Legacy admite ausencia/body vacío; atestación en legacy se rechaza.',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAuthorizationDto)
  customerAuthorization?: CustomerAuthorizationDto;
}
