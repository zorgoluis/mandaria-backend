import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const secret = () => randomBytes(32).toString('hex');
const password = secret();
const content = [
  'NODE_ENV=development',
  'PORT=3000',
  'POSTGRES_USER=mandaria',
  'POSTGRES_DB=mandaria',
  `POSTGRES_PASSWORD=${password}`,
  'POSTGRES_PORT=5432',
  `DATABASE_URL=postgresql://mandaria:${password}@localhost:5432/mandaria?schema=public&connect_timeout=5&socket_timeout=5`,
  `JWT_ACCESS_SECRET=${secret()}`,
  `JWT_REFRESH_SECRET=${secret()}`,
  'JWT_ACCESS_EXPIRES_IN=900',
  'JWT_REFRESH_EXPIRES_IN=604800',
  'CORS_ORIGINS=http://localhost:5173',
  'BOOTSTRAP_ADMIN_EMAIL=admin@mandaria.local',
  `BOOTSTRAP_ADMIN_PASSWORD=${secret()}`,
  '',
].join('\n');
try {
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.log(
    '.env created with random local secrets. Read bootstrap credentials locally; do not commit this file.',
  );
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; unchanged.');
  else throw error;
}
