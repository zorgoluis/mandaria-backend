import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const url = new URL(process.env.DATABASE_URL);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: 'postgres',
  PGCONNECT_TIMEOUT: '5',
};
const windowsPsql = 'C:/Program Files/PostgreSQL/18/bin/psql.exe';
const psql =
  process.env.PSQL_PATH || (existsSync(windowsPsql) ? windowsPsql : 'psql');
const check = spawnSync(
  psql,
  [
    '-X',
    '-w',
    '-tAc',
    "SELECT 1 FROM pg_database WHERE datname = 'mandaria_test'",
  ],
  { env, encoding: 'utf8' },
);
if (check.status !== 0) {
  console.error(
    'Cannot connect to PostgreSQL to create test database. Check DATABASE_URL and PSQL_PATH.',
  );
  process.exitCode = 1;
} else if (check.stdout.trim() === '1')
  console.log('mandaria_test already exists; unchanged.');
else {
  const result = spawnSync(
    psql,
    [
      '-X',
      '-w',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE DATABASE mandaria_test',
    ],
    { env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(
      'Cannot create mandaria_test. The configured role needs CREATEDB or an administrator must create it.',
    );
    process.exitCode = 1;
  } else console.log('Empty mandaria_test database created.');
}
