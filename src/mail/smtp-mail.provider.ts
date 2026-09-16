import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { renderUserInvitation } from './mail-templates.js';
import { MailDeliveryError } from './mail.types.js';
import type { MailProvider, UserInvitationMail } from './mail.types.js';

export type SmtpSettings = {
  host: string;
  port: number;
  /** true: implicit TLS (usually 465). false: STARTTLS, mandatory when requireTls. */
  secure: boolean;
  requireTls: boolean;
  user?: string;
  password?: string;
  from: string;
};

/** Short, non-sensitive failure code; SMTP error messages may echo addresses or credentials. */
export function smtpFailureReason(error: unknown) {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String(error.code)
      : '';
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : 'UNEXPECTED';
}

/** Production adapter for any SMTP relay (Resend, SES, Postmark, Mailgun, own server...). */
export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  constructor(
    private readonly settings: SmtpSettings,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        requireTLS: !settings.secure && settings.requireTls,
        auth: settings.user
          ? { user: settings.user, pass: settings.password }
          : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
      });
  }
  async sendUserInvitation(mail: UserInvitationMail) {
    const message = renderUserInvitation(mail);
    try {
      await this.transport.sendMail({
        from: this.settings.from,
        to: mail.to,
        ...message,
      });
    } catch (error) {
      throw new MailDeliveryError(smtpFailureReason(error));
    }
  }
}
