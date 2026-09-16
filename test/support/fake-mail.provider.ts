import { MailDeliveryError } from '../../dist/mail/mail.types.js';
import type {
  MailProvider,
  UserInvitationMail,
} from '../../dist/mail/mail.types.js';

/**
 * TEST ONLY MailProvider: keeps invitations in memory so E2E tests read the activation token
 * the way a person would, from the emailed link. Never bound outside tests.
 */
export class FakeMailProvider implements MailProvider {
  readonly name = 'fake';
  readonly sent: UserInvitationMail[] = [];
  /** Number of upcoming sends that fail as a transport error would. */
  failNext = 0;
  async sendUserInvitation(mail: UserInvitationMail) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new MailDeliveryError('EFAKE');
    }
    this.sent.push(mail);
  }
  to(email: string) {
    return this.sent.filter((mail) => mail.to === email);
  }
  last(email: string) {
    const mail = this.to(email).at(-1);
    if (!mail) throw new Error('No invitation email was sent');
    return mail;
  }
  tokenFor(email: string) {
    const token = new URL(this.last(email).activationUrl).searchParams.get(
      'token',
    );
    if (!token) throw new Error('Invitation link has no token');
    return token;
  }
  tokens() {
    return this.sent.map((mail) =>
      new URL(mail.activationUrl).searchParams.get('token')!,
    );
  }
}
