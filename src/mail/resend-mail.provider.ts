import type { DriverVerificationMail } from './mail.types.js';
import {
  renderPartnerApplicationNotice,
  renderUserInvitation,
} from './mail-templates.js';
import { MailDeliveryError } from './mail.types.js';
import type {
  MailProvider,
  PartnerApplicationNoticeMail,
  UserInvitationMail,
} from './mail.types.js';

export type ResendSettings = { apiKey: string; from: string };

/** HTTPS only. Provider errors never expose response bodies, tokens or addresses. */
export class ResendMailProvider implements MailProvider {
  readonly name = 'resend';
  constructor(
    private readonly settings: ResendSettings,
    private readonly request: typeof fetch = fetch,
  ) {}

  sendUserInvitation(mail: UserInvitationMail) {
    return this.send(mail.to, renderUserInvitation(mail));
  }

  sendPartnerApplicationNotice(mail: PartnerApplicationNoticeMail) {
    return this.send(mail.to, renderPartnerApplicationNotice(mail));
  }

  sendDriverVerification(mail: DriverVerificationMail) {
    const text =
      mail.kind !== 'DECISION'
        ? 'Registro Mandaria de prueba local. Token de confirmación: ' +
          mail.token
        : 'Mandaria: existe una decisión documental. Consulta tu cuenta. Referencia: ' +
          mail.reference;
    return this.send(
      mail.to,
      { subject: 'Mandaria — verificación documental', text },
      mail.idempotencyKey,
    );
  }
  private async send(
    to: string,
    content: { subject: string; text: string; html?: string },
    idempotencyKey?: string,
  ) {
    const signal = AbortSignal.timeout(20_000);
    try {
      const response = await this.request('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.settings.from,
          to: [to],
          ...content,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new MailDeliveryError(`RESEND_HTTP_${response.status}`);
      }
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !result.id.trim()
      )
        throw new MailDeliveryError('RESEND_INVALID_RESPONSE');
      // Acceptance by Resend is not proof of inbox delivery. No automatic retries.
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      if (signal.aborted) throw new MailDeliveryError('RESEND_TIMEOUT');
      if (error instanceof SyntaxError)
        throw new MailDeliveryError('RESEND_INVALID_RESPONSE');
      throw new MailDeliveryError('RESEND_NETWORK');
    }
  }
}
