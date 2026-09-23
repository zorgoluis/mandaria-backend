import {
  INestApplication,
  Logger,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpErrorFilter } from './common/http-exception.filter.js';
export function setup(app: INestApplication) {
  const config = app.get(ConfigService);
  app.use(helmet());
  app.use(json({ limit: '16kb' }));
  app.use(urlencoded({ extended: false, limit: '16kb' }));
  app.enableCors({
    origin: config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .filter(Boolean),
    credentials: false,
    // Browsers may only read non-safelisted response headers that are exposed explicitly; Mandaria
    // Web needs this one to tell an idempotent replay from a new movement.
    exposedHeaders: ['Idempotent-Replayed'],
  });
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  const logger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    res.on('finish', () =>
      logger.log({
        event: 'http_request',
        method: req.method,
        route:
          (req.route as { path?: string } | undefined)?.path ?? 'unmatched',
        status: res.statusCode,
        durationMs: Date.now() - started,
      }),
    );
    next();
  });
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Mandaria Core')
      .setVersion('1.10.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'User Bearer Authentication: human access token',
      })
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Integration Bearer Authentication: token from /integrations/token',
        },
        'integration-bearer',
      )
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);
  app.enableShutdownHooks();
  return doc;
}
