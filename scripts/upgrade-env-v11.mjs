import { randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { parse } from 'dotenv';
const env = parse(readFileSync('.env'));
const additions = [];
if (!env.INTEGRATION_JWT_SECRET)
  additions.push(`INTEGRATION_JWT_SECRET=${randomBytes(48).toString('hex')}`);
if (!env.INTEGRATION_ACCESS_TOKEN_EXPIRES_IN)
  additions.push('INTEGRATION_ACCESS_TOKEN_EXPIRES_IN=3600');
if (additions.length)
  appendFileSync('.env', '\n' + additions.join('\n') + '\n');
console.log(
  'V1.1 integration configuration ready; existing values preserved. No secrets printed.',
);
