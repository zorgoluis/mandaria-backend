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
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpErrorFilter } from './common/http-exception.filter.js';
import { randomUUID } from 'node:crypto';
export function setup(app: INestApplication) {
  const config = app.get(ConfigService);
  // Behind nginx every request arrives from the proxy's address: without this, rate limits would
  // be shared by all clients. Only the configured number of hops is trusted.
  const proxyHops = config.get<number>('TRUST_PROXY_HOPS') ?? 0;
  if (proxyHops > 0)
    (app as NestExpressApplication).set('trust proxy', proxyHops);
  // Server-generated correlation only: never trust/log an incoming request-id header.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    next();
  });
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
    exposedHeaders: ['Idempotent-Replayed', 'X-Request-Id', 'Retry-After'],
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
        requestId: res.locals.requestId,
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
      .setVersion('1.12.0')
      .addSecurity('tracking-link', {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description:
          'Tracking selector.secret; never put the secret in the API URL.',
      })
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
