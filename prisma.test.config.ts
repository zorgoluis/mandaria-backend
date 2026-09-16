import { defineConfig } from 'prisma/config';
import { testDatabaseUrl } from './scripts/test-database-url.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  engine: 'classic',
  datasource: { url: testDatabaseUrl() },
});
