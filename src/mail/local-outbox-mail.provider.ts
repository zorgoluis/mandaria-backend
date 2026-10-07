import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  renderPartnerApplicationNotice,
  renderUserInvitation,
} from './mail-templates.js';
import type {
  CustomerAccessMail,
  MailProvider,
  PartnerApplicationNoticeMail,
  UserInvitationMail,
} from './mail.types.js';

/**
 * LOCAL/TEST ONLY. Writes each message as a private JSON file instead of sending it, so an
 * invitation can be completed in development without a mail server. The files contain the
 * activation link (raw token): the directory lives outside the repository and production
 * configuration rejects this provider.
 */
export class LocalOutboxMailProvider implements MailProvider {
  readonly name = 'local_outbox';
  constructor(readonly directory: string) {}
  sendUserInvitation(mail: UserInvitationMail) {
    return this.write({
      kind: 'USER_INVITATION',
      to: mail.to,
      role: mail.role,
      activationUrl: mail.activationUrl,
      expiresAt: mail.expiresAt.toISOString(),
      ...renderUserInvitation(mail),
    });
  }
  sendPartnerApplicationNotice(mail: PartnerApplicationNoticeMail) {
    return this.write({
      kind: 'PARTNER_APPLICATION_NOTICE',
      to: mail.to,
      reference: mail.reference,
      ...renderPartnerApplicationNotice(mail),
    });
  }
  sendCustomerAccess(mail: CustomerAccessMail) {
    return this.write({
      kind: 'CUSTOMER_ACCESS',
      to: mail.to,
      purpose: mail.purpose,
      actionUrl: mail.actionUrl,
      expiresAt: mail.expiresAt.toISOString(),
    });
  }
  private async write(message: Record<string, unknown>) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(
      file,
      JSON.stringify(
        { ...message, createdAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
  }
}
