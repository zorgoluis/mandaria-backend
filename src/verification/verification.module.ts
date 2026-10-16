import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { VerificationRuntime } from './verification-policy.js';
import { VerificationService } from './verification.service.js';
import {
  VerificationController,
  DriverRegistrationController,
} from './verification.controller.js';
import {
  DisabledVerificationStorage,
  SpacesVerificationStorage,
  VERIFICATION_STORAGE,
} from './verification-storage.js';
import { VerificationNotifications } from './verification-notifications.js';
@Module({
  imports: [AuthModule, MailModule],
  controllers: [VerificationController, DriverRegistrationController],
  providers: [
    VerificationRuntime,
    VerificationService,
    VerificationNotifications,
    {
      provide: VERIFICATION_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (
          config.get<boolean>('DRIVER_VERIFICATION_LOCAL_ENABLED') &&
          config.get<string>('NODE_ENV') !== 'production' &&
          config.get<string>('VERIFICATION_SPACES_ENDPOINT')
        )
          return new SpacesVerificationStorage(
            config.getOrThrow<string>('VERIFICATION_SPACES_BUCKET'),
            {
              endpoint: config.getOrThrow<string>(
                'VERIFICATION_SPACES_ENDPOINT',
              ),
              accessKeyId: config.getOrThrow<string>(
                'VERIFICATION_SPACES_ACCESS_KEY',
              ),
              secretAccessKey: config.getOrThrow<string>(
                'VERIFICATION_SPACES_SECRET_KEY',
              ),
            },
          );
        return new DisabledVerificationStorage();
      },
    },
  ],
})
export class VerificationModule {}
