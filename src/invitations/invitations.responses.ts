import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProviderMemberRole } from '@prisma/client';
import { PaginationResponse } from '../providers/providers.responses.js';
import {
  INVITABLE_ROLES,
  INVITATION_STATUSES,
  USER_ACCOUNT_STATUSES,
} from './invitation-policy.js';

class InvitationProviderResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Rápidos de Coita' }) name!: string;
  @ApiProperty({ example: 'RAPIDOS_COITA' }) code!: string;
}
export class UserInvitationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'User INVITED creado (o reutilizado) para esta invitación.',
  })
  userId!: string;
  @ApiProperty({ example: 'repartidor@example.com' }) email!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) role!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({ type: InvitationProviderResponse })
  provider!: InvitationProviderResponse;
  @ApiPropertyOptional({
    enum: ProviderMemberRole,
    nullable: true,
    description: 'Sólo PROVIDER_ADMIN: rol local de la membership a crear.',
  })
  membershipRole!: ProviderMemberRole | null;
  @ApiPropertyOptional({
    nullable: true,
    example: 'Carlos Pérez',
    description: 'Sólo DRIVER: nombre del Driver a crear.',
  })
  driverName!: string | null;
  @ApiProperty({
    enum: INVITATION_STATUSES,
    description:
      'Estado efectivo. EXPIRED no se persiste: es una PENDING con expiresAt vencido (now >= expiresAt).',
  })
  status!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({
    format: 'date-time',
    description: 'Emisión del token vigente (creación o último reenvío).',
  })
  tokenIssuedAt!: Date;
  @ApiProperty({ example: 0 }) resendCount!: number;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  acceptedAt!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  revokedAt!: Date | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  revokedByUserId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdByUserId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
export class UserInvitationDispatchResponse extends UserInvitationResponse {
  @ApiProperty({
    enum: ['SENT', 'FAILED'],
    description:
      'Resultado del envío del correo, posterior al commit. FAILED conserva la invitación: puede reenviarse. El enlace y el token nunca se devuelven.',
  })
  emailDelivery!: string;
}
export class UserInvitationPageResponse extends PaginationResponse {
  @ApiProperty({ type: UserInvitationResponse, isArray: true })
  items!: UserInvitationResponse[];
}
export class ActivateAccountResponse {
  @ApiProperty({ enum: ['ACTIVE'] }) status!: string;
  @ApiProperty({ example: 'repartidor@example.com' }) email!: string;
  @ApiProperty({ enum: INVITABLE_ROLES }) role!: string;
}
export class UserResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['SUPER_ADMIN', 'PROVIDER_ADMIN', 'DRIVER'] })
  role!: string;
  @ApiProperty({
    description:
      'true sólo para cuentas ACTIVE; se conserva por compatibilidad.',
  })
  active!: boolean;
  @ApiProperty({
    enum: USER_ACCOUNT_STATUSES,
    description:
      'INVITED: nunca activada (sin contraseña). ACTIVE: puede iniciar sesión. DISABLED: inactiva con contraseña previa.',
  })
  status!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  emailVerifiedAt!: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
