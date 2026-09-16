import { ApiParam } from '@nestjs/swagger';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';

export const invitationParam = ApiParam({
  name: 'invitationId',
  format: 'uuid',
  description:
    'UserInvitation.id. Una invitación fuera del alcance del usuario responde 404.',
});

const common = {
  400: 'VALIDATION_ERROR: UUID, email, rol o campos inválidos; no se aceptan campos desconocidos (p. ej. role en rutas de proveedor).',
  401: 'Se requiere access JWT humano válido de un User ACTIVE; un token B2B (IntegrationClient) no es válido aquí.',
  403: 'Rol global insuficiente (DRIVER no invita) o falta membership del proveedor solicitado.',
  404: 'Proveedor o invitación no encontrados (o fuera del alcance del usuario).',
  500: 'Error interno sanitizado.',
};

export const ApiInviteErrors = (limit: number) =>
  ApiErrorDescriptions({
    ...common,
    409: 'USER_ALREADY_ACTIVE (email de cuenta activa) | USER_INVITATION_PENDING (ya existe invitación pendiente, vigente o vencida: usar resend) | USER_DISABLED (cuenta deshabilitada; no se reactiva por invitación) | PROVIDER_DRIVER_LIMIT_REACHED (Drivers + invitaciones DRIVER pendientes vigentes alcanzan maxDrivers).',
    429: `Límite de ${limit} peticiones/minuto por IP.`,
    503: 'MAIL_NOT_CONFIGURED: MANDARIA_WEB_URL no configurada; no se crea nada.',
  });

export const ApiResendErrors = ApiErrorDescriptions({
  ...common,
  409: 'INVITATION_NOT_PENDING (aceptada o revocada) | PROVIDER_DRIVER_LIMIT_REACHED (reactivar una invitación DRIVER vencida excedería maxDrivers).',
  429: 'INVITATION_RESEND_COOLDOWN (token emitido hace menos de USER_INVITATION_RESEND_COOLDOWN_SECONDS) o límite de 10 peticiones/minuto por IP.',
  503: 'MAIL_NOT_CONFIGURED: MANDARIA_WEB_URL no configurada; el token no se rota.',
});

export const ApiRevokeErrors = ApiErrorDescriptions({
  ...common,
  409: 'INVITATION_NOT_PENDING: una invitación aceptada no puede revocarse.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
});

export const ApiReadErrors = ApiErrorDescriptions({
  ...common,
  429: 'Límite de peticiones por IP excedido (100/minuto).',
});

export const RESEND_DOC =
  ' Rota el token (el enlace anterior deja de funcionar), reinicia expiresAt con USER_INVITATION_TTL_HOURS y envía un correo nuevo. Válido para PENDING vigentes o vencidas; no crea otro User. Peticiones simultáneas rotan el token una sola vez (bloqueo de fila + enfriamiento). 10/min por IP.';
export const REVOKE_DOC =
  ' Invalida el token. El User sigue INVITED (sin contraseña ni acceso) y puede invitarse de nuevo; no existe membership ni Driver que limpiar porque se crean al activar. Nada se borra. Revocar dos veces es idempotente.';
