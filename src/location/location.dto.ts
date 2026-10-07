import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsUUID,
  Matches,
  Max,
  Min,
  IsIn,
} from 'class-validator';

export class OpenLocationStreamDto {
  @ApiProperty({
    type: String,
    example: '1',
    description: 'Revisión decimal obtenida por GET; CAS obligatorio.',
  })
  @Matches(/^[1-9][0-9]{0,18}$/)
  expectedStreamRevision!: string;
}
export class LocationSampleDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() streamId!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  sequence!: number;
  @ApiProperty({ format: 'date-time' })
  @IsDateString({ strict: true })
  @Matches(/T.*Z$/)
  capturedAt!: string;
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;
  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
  @ApiProperty({
    description:
      'Metros. Más de 100 se rechaza como señal insuficiente, sin sustituir la muestra anterior.',
  })
  @IsNumber()
  @Min(0.001)
  @Max(100000)
  accuracyMeters!: number;
}
export class TrackingLinkDto {
  @ApiProperty({
    type: String,
    example: '1',
    description:
      'Revisión decimal consultada; obliga a reconciliar conflictos antes de otra intención.',
  })
  @Matches(/^[1-9][0-9]{0,18}$/)
  expectedLinkRevision!: string;
}
export class TrackingLinkAttemptDto extends TrackingLinkDto {
  @ApiProperty({ enum: ['ISSUE', 'REVOKE'] })
  @IsIn(['ISSUE', 'REVOKE'])
  operation!: 'ISSUE' | 'REVOKE';
}
