import { renderUserInvitation } from './mail-templates.js';
import { MailDeliveryError } from './mail.types.js';
import type { MailProvider, UserInvitationMail } from './mail.types.js';

export type ResendSettings = { apiKey: string; from: string };

/** HTTPS only. Provider errors never expose response bodies, tokens or addresses. */
export class ResendMailProvider implements MailProvider {
  readonly name = 'resend';
  constructor(
    private readonly settings: ResendSettings,
    private readonly request: typeof fetch = fetch,
  ) {}

  async sendUserInvitation(mail: UserInvitationMail) {
    const signal = AbortSignal.timeout(20_000);
    try {
      const response = await this.request('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.settings.from,
          to: [mail.to],
          ...renderUserInvitation(mail),
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
