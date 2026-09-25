import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalOutboxMailProvider } from './local-outbox-mail.provider.js';
import { ResendMailProvider } from './resend-mail.provider.js';
import { MAIL_PROVIDER } from './mail.types.js';

export const DEFAULT_LOCAL_MAIL_OUTBOX_DIR = join(
  tmpdir(),
  'mandaria-mail-outbox',
);

/** Binds MAIL_PROVIDER from configuration; E2E tests override the token with a fake. */
@Module({
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const production = config.get<string>('NODE_ENV') === 'production';
        if (config.getOrThrow<string>('MAIL_PROVIDER') === 'resend')
          return new ResendMailProvider({
            apiKey: config.getOrThrow<string>('RESEND_API_KEY'),
            from: config.getOrThrow<string>('MAIL_FROM'),
          });
        // Defense in depth: environment validation already rejects this combination.
        if (config.getOrThrow<string>('MAIL_PROVIDER') !== 'local_outbox')
          throw new Error('Unsupported mail provider');
        if (production)
          throw new Error('local_outbox mail is not allowed in production');
        return new LocalOutboxMailProvider(
          config.get<string>('LOCAL_MAIL_OUTBOX_DIR') ??
            DEFAULT_LOCAL_MAIL_OUTBOX_DIR,
        );
      },
    },
  ],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}
