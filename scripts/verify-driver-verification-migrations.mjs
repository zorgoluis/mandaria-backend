import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const pg = 'C:/Program Files/PostgreSQL/18/bin';
const db = 'verification_upgrade_' + Date.now() + '_test';
const url = `postgresql://postgres@127.0.0.1:55439/${db}`;
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error((r.stderr + r.stdout).slice(-3000));
  return r.stdout;
};
const temp = mkdtempSync(join(tmpdir(), 'mandaria-verification-upgrade-'));
mkdirSync(join(temp, 'migrations'));
const names = readdirSync('prisma/migrations').filter(
  (x) => /^\d/.test(x) && x !== '20261013000100_driver_verification',
);
if (names.length !== 32)
  throw new Error('Main baseline must have exactly 32 migrations');
for (const name of names)
  cpSync(
    join(root, 'prisma/migrations', name),
    join(temp, 'migrations', name),
    { recursive: true },
  );
cpSync(
  'prisma/migrations/migration_lock.toml',
  join(temp, 'migrations/migration_lock.toml'),
);
const before = run('git', ['show', 'HEAD:prisma/schema.prisma']);
writeFileSync(join(temp, 'schema.prisma'), before);
// Config lives beside copied main schema/migrations and uses explicit isolated DATABASE_URL.
const config = join(root, '.tmp', 'verification-upgrade.config.ts');
writeFileSync(
  config,
  `import {defineConfig} from 'prisma/config';export default defineConfig({schema:${JSON.stringify(join(temp, 'schema.prisma'))},migrations:{path:${JSON.stringify(join(temp, 'migrations'))}}});`,
);
run(join(pg, 'createdb.exe'), [
  '-h',
  '127.0.0.1',
  '-p',
  '55439',
  '-U',
  'postgres',
  db,
]);
run(
  process.execPath,
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    config,
  ],
  { DATABASE_URL: url },
);
const psql = (args) =>
  run(join(pg, 'psql.exe'), [
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    '127.0.0.1',
    '-p',
    '55439',
    '-U',
    'postgres',
    '-d',
    db,
    ...args,
  ]);
psql([
  '-c',
  `INSERT INTO "User" (id,email,"passwordHash",role,active,"updatedAt") VALUES ('10000000-0000-4000-8000-000000000001','upgrade-synthetic@example.test','unusable','DRIVER',true,now()); INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES ('10000000-0000-4000-8000-000000000002','Synthetic','UPGRADE-SYNTHETIC','FLEET','ACTIVE',10,10,now()); INSERT INTO "Driver" (id,"providerId","userId",name,status,availability,"updatedAt") VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Synthetic','ACTIVE','OFFLINE',now());`,
]);
const snapshot = () =>
  psql([
    '-At',
    '-c',
    `SELECT md5(string_agg(row_to_json(d)::text,'' ORDER BY id)) FROM "Driver" d`,
  ]).trim();
const hash = snapshot();
run(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  { DATABASE_URL: url },
);
if (snapshot() !== hash) throw new Error('Historical Driver changed');
run(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  { DATABASE_URL: url },
);
const drift = run(
  process.execPath,
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'diff',
    '--from-url',
    url,
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--exit-code',
  ],
  { DATABASE_URL: url },
);
const result = {
  baseMigrations: names.length,
  totalMigrations: 33,
  database: db,
  mainDriverPreserved: true,
  reapply: true,
  drift: drift.trim(),
  historicalDriverPreserved: true,
};
writeFileSync(
  '.tmp/verification-upgrade-result.json',
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
