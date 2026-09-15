import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IntegrationStatus } from '@prisma/client';
export class CreateIntegrationDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ example: 'COITA_EATS' })
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  code!: string;
}
export class UpdateIntegrationDto {
  @ApiProperty({ enum: IntegrationStatus })
  @IsEnum(IntegrationStatus)
  status!: IntegrationStatus;
}
