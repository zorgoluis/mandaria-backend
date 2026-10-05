import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
} from 'class-validator';
import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  PARTNER_APPLICATION_STATUSES,
  PARTNER_APPLICATION_TYPES,
  PARTNER_VEHICLE_TYPES,
} from './partner-application-policy.js';
import type {
  PartnerApplicationStatus,
  PartnerApplicationType,
} from '@prisma/client';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Same normalization as login and invitations: trimmed and lowercase. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const optional = () => ValidateIf((_o, v) => v !== undefined);
/**
 * "received, CONTACTED,received" -> ['RECEIVED', 'CONTACTED']: trimmed, uppercase, duplicates
 * ignored. Empty entries are kept so validation rejects "RECEIVED," and ",". A repeated query
 * parameter (?status=A&status=B) arrives as an array and is read the same way.
 */
const statusList = ({ value }: { value: unknown }) => {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (typeof raw !== 'string') return raw;
  return [...new Set(raw.split(',').map((item) => item.trim().toUpperCase()))];
};

/** fleetName/fleetUnits are required with FLEET and forbidden with INDIVIDUAL. */
@ValidatorConstraint({ name: 'onlyForFleet' })
class OnlyForFleet implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    return (args.object as { type?: unknown }).type === 'FLEET';
  }
  defaultMessage(args: ValidationArguments) {
    return `${args.property} is only allowed with type FLEET`;
  }
}
const fleetOnly = (property: 'fleetName' | 'fleetUnits') =>
  ValidateIf(
    (o: CreatePartnerApplicationDto) =>
      o.type === 'FLEET' || (o[property] !== undefined && o[property] !== null),
  );

export class CreatePartnerApplicationDto {
  @ApiProperty({ enum: PARTNER_APPLICATION_TYPES })
  @IsIn(PARTNER_APPLICATION_TYPES)
  type!: PartnerApplicationType;

  @ApiProperty({ minLength: 2, maxLength: 100, example: 'Ana López' })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  contactName!: string;

  @ApiProperty({
    pattern: '^[0-9]{10}$',
    example: '9611234567',
    description: 'Exactamente 10 dígitos (México, sin lada de país).',
  })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{10}$/, { message: 'phone must be exactly 10 digits' })
  phone!: string;

  @ApiProperty({
    maxLength: 254,
    example: 'ana@example.com',
    description: 'Se normaliza a minúsculas.',
  })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 2, maxLength: 80, example: 'Tuxtla Gutiérrez' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  city!: string;

  @ApiProperty({
    enum: PARTNER_VEHICLE_TYPES,
    description:
      'Bicicleta→BICYCLE, Moto→MOTORCYCLE, Auto→CAR, Camioneta→PICKUP, Camión→TRUCK.',
  })
  @IsIn(PARTNER_VEHICLE_TYPES)
  vehicleType!: (typeof PARTNER_VEHICLE_TYPES)[number];

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    example: 'Mensajería del Sur',
    description: 'Obligatorio con FLEET; prohibido con INDIVIDUAL.',
  })
  @Transform(trim)
  @fleetOnly('fleetName')
  @Validate(OnlyForFleet)
  @IsString()
  @Length(2, 100)
  fleetName?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 2,
    maximum: 10000,
    example: 5,
    description: 'Obligatorio con FLEET; prohibido con INDIVIDUAL.',
  })
  @fleetOnly('fleetUnits')
  @Validate(OnlyForFleet)
  @IsInt()
  @Min(2)
  @Max(10000)
  fleetUnits?: number;

  @ApiProperty({ enum: [true], description: 'Debe ser literalmente true.' })
  @Equals(true, { message: 'privacyAccepted must be true' })
  privacyAccepted!: true;

  @ApiProperty({
    maxLength: 20,
    example: '2026-10',
    description: 'Versión del aviso de privacidad aceptado (LFPDPPP).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 20)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'privacyNoticeVersion has invalid characters',
  })
  privacyNoticeVersion!: string;

  @ApiPropertyOptional({
    description:
      'Honeypot: debe venir vacío o ausente. Un valor no vacío recibe 202 sin persistir nada.',
    example: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(0, { message: 'website must be empty' })
  @Transform(trim)
  website?: string;
}

export class PartnerApplicationListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: `Uno o varios estados separados por comas: ${PARTNER_APPLICATION_STATUSES.join(', ')}. Sin distinguir mayúsculas; se recortan espacios y se ignoran duplicados. Sin valores vacíos y como máximo 5. Omitido: todos los estados.`,
    examples: {
      abiertas: {
        value: 'RECEIVED,CONTACTED',
        summary: 'Solicitudes abiertas',
      },
      una: { value: 'RECEIVED', summary: 'Un solo estado' },
    },
    example: 'RECEIVED,CONTACTED',
  })
  @Transform(statusList)
  @optional()
  @ArrayMaxSize(PARTNER_APPLICATION_STATUSES.length)
  @IsIn(PARTNER_APPLICATION_STATUSES, {
    each: true,
    message: `status must be a comma-separated list of: ${PARTNER_APPLICATION_STATUSES.join(', ')}`,
  })
  status?: PartnerApplicationStatus[];
  @ApiPropertyOptional({ enum: PARTNER_APPLICATION_TYPES })
  @optional()
  @IsIn(PARTNER_APPLICATION_TYPES)
  type?: PartnerApplicationType;
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Búsqueda parcial sin distinguir mayúsculas en referencia, nombre, teléfono, correo y flotilla.',
  })
  @Transform(trim)
  @optional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}

export class ChangePartnerApplicationStatusDto {
  @ApiProperty({
    enum: PARTNER_APPLICATION_STATUSES,
    description:
      'RECEIVED→CONTACTED/REJECTED/DISCARDED; CONTACTED→APPROVED/REJECTED/DISCARDED; APPROVED→REJECTED (con reviewNote). REJECTED y DISCARDED son terminales.',
  })
  @IsIn(PARTNER_APPLICATION_STATUSES)
  status!: PartnerApplicationStatus;
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 500,
    description:
      'Nota interna sin datos sensibles. Si se omite se conserva la anterior. APPROVED exige nota o vínculo; APPROVED→REJECTED exige nota nueva.',
  })
  @Transform(trim)
  @optional()
  @IsString()
  @Length(1, 500)
  reviewNote?: string;
}

export class LinkPartnerApplicationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DeliveryProvider FLEET creado por el flujo existente. Sólo para solicitudes FLEET.',
  })
  @optional()
  @IsUUID()
  providerId?: string;
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'UserInvitation enviada por el flujo existente; su email debe coincidir con el de la solicitud.',
  })
  @optional()
  @IsUUID()
  invitationId?: string;
}
