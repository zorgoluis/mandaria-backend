import type { InvitedRole, UserInvitationMail } from './mail.types.js';

export const ROLE_LABELS: Record<InvitedRole, string> = {
  PROVIDER_ADMIN: 'Administrador de proveedor',
  DRIVER: 'Repartidor',
};
/** Mandaria operates in Chiapas, which follows central Mexico time. */
const EXPIRY_FORMAT = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Mexico_City',
});

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Builds {MANDARIA_WEB_URL}/activate-account?token=... preserving any base path. */
export function buildActivationUrl(baseUrl: string, token: string) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/activate-account`);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Plain, professional invitation. Never includes a password. */
export function renderUserInvitation(mail: UserInvitationMail) {
  const role = ROLE_LABELS[mail.role];
  const expires = `${EXPIRY_FORMAT.format(mail.expiresAt)} (hora del centro de México)`;
  const subject = 'Has sido invitado a Mandaria';
  const text = [
    'Has sido invitado a Mandaria',
    '',
    `Proveedor: ${mail.providerName}`,
    `Rol: ${role}`,
    '',
    'Para activar tu cuenta y crear tu contraseña abre el siguiente enlace:',
    mail.activationUrl,
    '',
    `La invitación expira el ${expires}. El enlace sólo puede usarse una vez.`,
    'Si no esperabas este correo, ignóralo: no se creará ningún acceso sin tu contraseña.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
    <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
      <tr><td>
        <h1 style="font-size:20px;margin:0 0 16px">Has sido invitado a Mandaria</h1>
        <p style="margin:0 0 4px"><strong>Proveedor:</strong> ${escapeHtml(mail.providerName)}</p>
        <p style="margin:0 0 24px"><strong>Rol:</strong> ${escapeHtml(role)}</p>
        <p style="margin:0 0 24px">
          <a href="${escapeHtml(mail.activationUrl)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px">Activar cuenta</a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#57534e">La invitación expira el ${escapeHtml(expires)}. El enlace sólo puede usarse una vez.</p>
        <p style="margin:0;font-size:13px;color:#57534e">Si no esperabas este correo, ignóralo: no se creará ningún acceso sin tu contraseña.</p>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, text, html };
}
