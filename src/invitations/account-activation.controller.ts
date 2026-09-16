import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import { InvitationsService } from './invitations.service.js';
import { ActivateAccountDto } from './invitations.dto.js';
import { ActivateAccountResponse } from './invitations.responses.js';

@ApiTags('Auth')
@Controller('auth')
export class AccountActivationController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('activate-account')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOkResponse({ type: ActivateAccountResponse })
  @ApiErrorDescriptions({
    400: 'VALIDATION_ERROR (contraseña fuera de 16-128 caracteres, campos faltantes o desconocidos) | INVITATION_TOKEN_INVALID (token desconocido, reemplazado por un reenvío o malformado).',
    409: 'INVITATION_ALREADY_ACCEPTED (el token ya se usó) | ACCOUNT_NOT_ACTIVATABLE | PROVIDER_DRIVER_LIMIT_REACHED (el proveedor ya no tiene lugar; la cuenta no se activa).',
    410: 'INVITATION_EXPIRED (now >= expiresAt; pedir reenvío) | INVITATION_REVOKED.',
    429: 'Límite de 10 peticiones/minuto por IP.',
    500: 'Error interno sanitizado.',
  })
  @ApiOperation({
    summary: 'Activar cuenta invitada',
    description:
      'Público, sin sesión. Recibe el token del enlace del correo y la contraseña elegida por la persona invitada (misma política de 16-128 caracteres del bootstrap; Argon2id). En una sola transacción: User ACTIVE con el rol invitado y email verificado, ProviderMembership (PROVIDER_ADMIN) o Driver PENDING/OFFLINE (DRIVER) en el proveedor de la invitación, e invitación ACCEPTED. El token es de un solo uso: activaciones simultáneas producen un éxito y el resto 409. No devuelve tokens de sesión: después se usa POST /auth/login. Los errores no revelan datos de otras cuentas.',
  })
  activate(@Body() dto: ActivateAccountDto) {
    return this.invitations.activate(dto.token, dto.password);
  }
}
