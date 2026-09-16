import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ProviderMemberRole } from '@prisma/client';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../common/password-policy.js';
import { INVITABLE_ROLES, INVITATION_STATUSES } from './invitation-policy.js';
import type {
  InvitableRole,
  InvitationEffectiveStatus,
} from './invitation-policy.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Same normalization as login: trimmed and lowercase. */
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const optional = () => ValidateIf((_o, v) => v !== undefined);

const emailProperty = {
  description:
    'Email de la persona invitada. Se normaliza (trim + minúsculas) igual que en login; User@Mail.com y user@mail.com son la misma cuenta.',
  example: 'repartidor@example.com',
  maxLength: 254,
};
const driverNameProperty = {
  description:
    'Nombre operativo del Driver que se creará al activar la cuenta. Se recortan espacios.',
  example: 'Carlos Pérez',
  minLength: 1,
  maxLength: 100,
};

export class CreateUserInvitationDto {
  @ApiProperty(emailProperty)
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty({
    enum: INVITABLE_ROLES,
    description:
      'Rol global de la cuenta. SUPER_ADMIN no es invitable: el único alta de SUPER_ADMIN es el bootstrap.',
  })
  @IsIn(INVITABLE_ROLES)
  role!: InvitableRole;
  @ApiPropertyOptional({
    enum: ProviderMemberRole,
    description:
      'Obligatorio sólo con role PROVIDER_ADMIN: rol local de la membership creada al activar. Prohibido con DRIVER.',
  })
  @optional()
  @IsEnum(ProviderMemberRole)
  membershipRole?: ProviderMemberRole;
  @ApiPropertyOptional({
    ...driverNameProperty,
    description: `Obligatorio sólo con role DRIVER. ${driverNameProperty.description} Prohibido con PROVIDER_ADMIN.`,
  })
  @Transform(trim)
  @optional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  driverName?: string;
}

/** PROVIDER_ADMIN payload: there is no role field, so a client cannot request another role. */
export class CreateDriverInvitationDto {
  @ApiProperty(emailProperty)
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty(driverNameProperty)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  driverName!: string;
}

class InvitationFilterDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: INVITATION_STATUSES,
    description:
      'Estado efectivo. PENDING = vigente; EXPIRED = PENDING con expiresAt vencido.',
  })
  @optional()
  @IsIn(INVITATION_STATUSES)
  status?: InvitationEffectiveStatus;
  @ApiPropertyOptional({
    description: 'Búsqueda parcial por email, sin distinguir mayúsculas.',
    maxLength: 254,
  })
  @Transform(trim)
  @optional()
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  search?: string;
}
export class AdminInvitationListQueryDto extends InvitationFilterDto {
  @ApiPropertyOptional({ enum: INVITABLE_ROLES })
  @optional()
  @IsIn(INVITABLE_ROLES)
  role?: InvitableRole;
  @ApiPropertyOptional({ format: 'uuid' })
  @optional()
  @IsUUID()
  providerId?: string;
}
export class ProviderInvitationListQueryDto extends InvitationFilterDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Proveedor propio. Puede omitirse sólo con exactamente una membership.',
  })
  @optional()
  @IsUUID()
  providerId?: string;
}

export class ActivateAccountDto {
  @ApiProperty({
    description:
      'Token de un solo uso recibido en el enlace del correo (parámetro token). Nunca se almacena en claro.',
    example: '<token-del-enlace>',
    maxLength: 256,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token!: string;
  @ApiProperty({
    format: 'password',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: `Contraseña elegida por la persona invitada: ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} caracteres, la misma política del bootstrap SUPER_ADMIN. Se guarda con Argon2id.`,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
