import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleRoutingProvider } from './google-routing.provider.js';
import { LocalFakeRoutingProvider } from './local-fake-routing.provider.js';
import { ROUTING_PROVIDER } from './routing.types.js';

/** Binds ROUTING_PROVIDER from configuration; tests override the token with a fake. */
@Module({
  providers: [
    {
      provide: ROUTING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.getOrThrow<string>('ROUTING_PROVIDER') === 'local_fake'
          ? new LocalFakeRoutingProvider()
          : new GoogleRoutingProvider(config),
    },
  ],
  exports: [ROUTING_PROVIDER],
})
export class RoutingModule {}
