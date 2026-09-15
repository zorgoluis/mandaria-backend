import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { setup } from './setup.js';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new ConsoleLogger({ json: true }),
  });
  setup(app);
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log({ event: 'application_started', port });
}
void bootstrap().catch(() => {
  process.stderr.write(
    'Mandaria startup failed. Check configuration and database availability.\n',
  );
  process.exitCode = 1;
});
