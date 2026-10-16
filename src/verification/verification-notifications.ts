import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAIL_PROVIDER, type MailProvider } from '../mail/mail.types.js';
/** Durable decision outbox. Provider acceptance is never represented as inbox delivery. */
@Injectable()
export class VerificationNotifications
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
  ) {}
  onModuleInit() {
    if (
      this.config.get<boolean>('DRIVER_VERIFICATION_LOCAL_ENABLED') &&
      this.config.get<string>('NODE_ENV') !== 'production'
    ) {
      this.timer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, 5000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      const notices = await this.db.$queryRaw<
        { id: string; attempts: number }[]
      >`UPDATE "VerificationNotice" SET status='SENDING', attempts=attempts+1,"leaseUntil"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '60 seconds' WHERE id IN (SELECT id FROM "VerificationNotice" WHERE attempts<5 AND ((status='PENDING' AND "retryAt"<=(clock_timestamp() AT TIME ZONE 'UTC')) OR (status='SENDING' AND "leaseUntil"<(clock_timestamp() AT TIME ZONE 'UTC'))) ORDER BY "createdAt" LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING id,attempts`;
      for (const n of notices) {
        const notice = await this.db.verificationNotice.findUniqueOrThrow({
          where: { id: n.id },
          include: {
            recipient: true,
            case: { include: { subject: { include: { driver: true } } } },
          },
        });
        const s = notice.case.subject;
        const allowed =
          notice.recipient.active &&
          (s.driver?.userId === notice.recipientId ||
            (notice.recipient.role === 'DRIVER' &&
              !s.providerId &&
              notice.case.presenterId === notice.recipientId) ||
            (notice.recipient.role === 'PROVIDER_ADMIN' &&
              s.providerId &&
              (await this.db.providerMembership.findFirst({
                where: { userId: notice.recipientId, providerId: s.providerId },
              }))));
        if (!allowed) {
          await this.db.verificationNotice.updateMany({
            where: { id: n.id, attempts: n.attempts, status: 'SENDING' },
            data: { status: 'SUPPRESSED', leaseUntil: null },
          });
          continue;
        }
        try {
          if (!this.mail.sendDriverVerification)
            throw new Error('MAIL_UNAVAILABLE');
          await this.mail.sendDriverVerification({
            to: notice.recipient.email,
            kind: 'DECISION',
            reference: notice.caseId,
            idempotencyKey: 'verification/' + n.id,
          });
          await this.db.verificationNotice.updateMany({
            where: { id: n.id, attempts: n.attempts, status: 'SENDING' },
            data: {
              status: 'ACCEPTED_BY_PROVIDER',
              leaseUntil: null,
              errorCode: null,
            },
          });
        } catch {
          await this.db.verificationNotice.updateMany({
            where: { id: n.id, attempts: n.attempts, status: 'SENDING' },
            data: {
              status: n.attempts >= 5 ? 'FAILED' : 'PENDING',
              leaseUntil: null,
              errorCode: 'MAIL_ACCEPTANCE_UNCONFIRMED',
              retryAt: new Date(
                Date.now() + Math.min(3600000, 30000 * 2 ** n.attempts),
              ),
            },
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
