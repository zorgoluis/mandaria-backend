// LOCAL/TEST ONLY: adds a random LOCAL_PROVIDER_ADMIN_PASSWORD to .env if missing.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
const env = parse(readFileSync('.env'));
if ((env.NODE_ENV ?? 'development') === 'production') {
  console.error(
    'Refusing to add local PROVIDER_ADMIN credentials to a production .env',
  );
  process.exitCode = 1;
} else if (env.LOCAL_PROVIDER_ADMIN_PASSWORD) {
  console.log('LOCAL_PROVIDER_ADMIN_PASSWORD already set; unchanged.');
} else {
  appendFileSync(
    '.env',
    `\n# LOCAL/TEST ONLY: shared password of seeded PROVIDER_ADMIN accounts\nLOCAL_PROVIDER_ADMIN_PASSWORD=${randomBytes(24).toString('hex')}\n`,
  );
  console.log(
    'LOCAL_PROVIDER_ADMIN_PASSWORD added to .env. Read it locally; no secrets printed.',
  );
}
