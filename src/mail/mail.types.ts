export type InvitedRole = 'PROVIDER_ADMIN' | 'DRIVER';

/** Everything a provider needs to deliver an invitation. activationUrl carries the raw token. */
export interface UserInvitationMail {
  to: string;
  role: InvitedRole;
  providerName: string;
  activationUrl: string;
  expiresAt: Date;
}

/**
 * Outbound email port. The domain depends only on this interface; SMTP, the local outbox and
 * test fakes are interchangeable adapters bound to MAIL_PROVIDER.
 */
export interface MailProvider {
  readonly name: string;
  sendUserInvitation(mail: UserInvitationMail): Promise<void>;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

/** reason is a short machine code (e.g. EAUTH, ECONNECTION); never a message or address. */
export class MailDeliveryError extends Error {
  constructor(readonly reason: string) {
    super(`MAIL_DELIVERY_FAILED: ${reason}`);
  }
}
