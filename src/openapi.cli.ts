import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { setup } from './setup.js';

// Export metadata without loading local credentials, connecting to PostgreSQL,
// initializing modules or opening an HTTP listener.
export async function createOpenApiDocument() {
  process.env.DATABASE_URL = 'postgresql://localhost/mandaria_docs';
  for (const key of [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'INTEGRATION_JWT_SECRET',
  ]) {
    process.env[key] = randomBytes(48).toString('hex');
  }
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  try {
    return setup(app);
  } finally {
    await app.close();
  }
}

async function main() {
  const document = await createOpenApiDocument();
  await mkdir('docs', { recursive: true });
  await writeFile(
    'docs/openapi.json',
    JSON.stringify(document, null, 2) + '\n',
  );
  console.log('Generated docs/openapi.json');
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/openapi.cli.js')) {
  main().catch(() => {
    console.error('OpenAPI generation failed. Check build and configuration.');
    process.exitCode = 1;
  });
}
