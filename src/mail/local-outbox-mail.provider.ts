import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderUserInvitation } from './mail-templates.js';
import type { MailProvider, UserInvitationMail } from './mail.types.js';

/**
 * LOCAL/TEST ONLY. Writes each message as a private JSON file instead of sending it, so an
 * invitation can be completed in development without a mail server. The files contain the
 * activation link (raw token): the directory lives outside the repository and production
 * configuration rejects this provider.
 */
export class LocalOutboxMailProvider implements MailProvider {
  readonly name = 'local_outbox';
  constructor(readonly directory: string) {}
  async sendUserInvitation(mail: UserInvitationMail) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(
      file,
      JSON.stringify(
        {
          kind: 'USER_INVITATION',
          to: mail.to,
          role: mail.role,
          activationUrl: mail.activationUrl,
          expiresAt: mail.expiresAt.toISOString(),
          ...renderUserInvitation(mail),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
  }
}
